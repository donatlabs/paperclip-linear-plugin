/**
 * Tiny GraphQL client for the Linear API.
 *
 * The plugin only needs a handful of operations (viewer, teams, projects,
 * labels, issues by id, issue search, issue create/update, comment create), so
 * we hand-roll typed wrappers instead of pulling in a full SDK. All HTTP calls
 * go through `ctx.http` so the host can trace and audit them.
 */

import type { PluginHttpClient, PluginLogger } from "@paperclipai/plugin-sdk";
import type {
  LinearIssue,
  LinearLabel,
  LinearProject,
  LinearTeam,
  LinearViewer,
  LinearWorkflowState,
} from "./types.js";

export interface LinearClientOptions {
  apiUrl: string;
  apiKey: string;
  http: PluginHttpClient;
  logger: PluginLogger;
}

export class LinearApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "LinearApiError";
  }
}

const ISSUE_FIELDS = `
  id identifier title description url updatedAt createdAt
  state { id name type }
  team { id key name }
  project { id name }
  labels { nodes { id name color } }
`;

export class LinearClient {
  constructor(private readonly opts: LinearClientOptions) {}

  async viewer(): Promise<LinearViewer> {
    const data = await this.gql<{ viewer: LinearViewer }>(
      `query Viewer {
        viewer {
          id
          name
          email
          organization { id name urlKey }
        }
      }`,
    );
    return data.viewer;
  }

  async listTeams(): Promise<LinearTeam[]> {
    const data = await this.gql<{ teams: { nodes: LinearTeam[] } }>(
      `query Teams {
        teams(first: 100) {
          nodes { id key name }
        }
      }`,
    );
    return data.teams.nodes;
  }

  async listProjects(): Promise<LinearProject[]> {
    const data = await this.gql<{
      projects: {
        nodes: Array<{
          id: string;
          name: string;
          description: string | null;
          state: string | null;
          url: string;
          teams: { nodes: Array<{ id: string; key: string; name: string }> };
        }>;
      };
    }>(
      `query Projects {
        projects(first: 200) {
          nodes {
            id name description state url
            teams(first: 5) { nodes { id key name } }
          }
        }
      }`,
    );
    return data.projects.nodes.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      state: p.state,
      url: p.url,
      teams: p.teams.nodes,
    }));
  }

  async listWorkflowStates(teamId: string): Promise<LinearWorkflowState[]> {
    const data = await this.gql<{
      workflowStates: { nodes: LinearWorkflowState[] };
    }>(
      `query WorkflowStates($filter: WorkflowStateFilter) {
        workflowStates(first: 100, filter: $filter) {
          nodes { id name type position team { id } }
        }
      }`,
      { filter: { team: { id: { eq: teamId } } } },
    );
    return data.workflowStates.nodes;
  }

  async listLabels(teamId?: string): Promise<LinearLabel[]> {
    const data = await this.gql<{ issueLabels: { nodes: LinearLabel[] } }>(
      `query Labels($filter: IssueLabelFilter) {
        issueLabels(first: 200, filter: $filter) {
          nodes { id name color team { id } }
        }
      }`,
      teamId ? { filter: { team: { id: { eq: teamId } } } } : { filter: {} },
    );
    return data.issueLabels.nodes;
  }

  /**
   * Find or create a workspace-scoped label. Linear labels can be team-scoped
   * or workspace-scoped. We use a workspace-scoped label (no `teamId`) so the
   * import filter works across every team the user maps.
   */
  async ensureWorkspaceLabel(name: string): Promise<LinearLabel> {
    const labels = await this.listLabels();
    const existing = labels.find((l) => l.name === name && !l.team);
    if (existing) return existing;
    const data = await this.gql<{
      issueLabelCreate: { success: boolean; issueLabel: LinearLabel | null };
    }>(
      `mutation CreateLabel($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) {
          success
          issueLabel { id name color team { id } }
        }
      }`,
      { input: { name, color: "#5e6ad2" } },
    );
    if (!data.issueLabelCreate.success || !data.issueLabelCreate.issueLabel) {
      throw new LinearApiError("issueLabelCreate returned success=false", 200, data);
    }
    return data.issueLabelCreate.issueLabel;
  }

  async getIssue(id: string): Promise<LinearIssue | null> {
    const data = await this.gql<{ issue: LinearIssue | null }>(
      `query Issue($id: String!) {
        issue(id: $id) { ${ISSUE_FIELDS} }
      }`,
      { id },
    );
    return data.issue ?? null;
  }

  async searchIssues(query: string, limit = 10): Promise<LinearIssue[]> {
    const data = await this.gql<{ issueSearch: { nodes: LinearIssue[] } }>(
      `query Search($query: String!, $first: Int!) {
        issueSearch(query: $query, first: $first) {
          nodes { ${ISSUE_FIELDS} }
        }
      }`,
      { query, first: limit },
    );
    return data.issueSearch.nodes;
  }

  /**
   * Pull issues updated since `since`, optionally filtered by a project, label,
   * or both. Used by incremental sync to scope work to mapped projects with
   * the import label applied.
   */
  async issuesUpdatedSince(
    since: string,
    options: { projectId?: string; labelName?: string; limit?: number } = {},
  ): Promise<LinearIssue[]> {
    const filter: Record<string, unknown> = { updatedAt: { gte: since } };
    if (options.projectId) filter.project = { id: { eq: options.projectId } };
    if (options.labelName) filter.labels = { name: { eq: options.labelName } };
    const data = await this.gql<{ issues: { nodes: LinearIssue[] } }>(
      `query IssuesUpdatedSince($filter: IssueFilter, $first: Int!) {
        issues(first: $first, orderBy: updatedAt, filter: $filter) {
          nodes { ${ISSUE_FIELDS} }
        }
      }`,
      { filter, first: options.limit ?? 100 },
    );
    return data.issues.nodes;
  }

  async createIssue(input: {
    teamId: string;
    title: string;
    description?: string | undefined;
    projectId?: string | undefined;
    labelIds?: string[] | undefined;
    stateId?: string | undefined;
    parentId?: string | undefined;
  }): Promise<LinearIssue> {
    const data = await this.gql<{
      issueCreate: { success: boolean; issue: LinearIssue | null };
    }>(
      `mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { ${ISSUE_FIELDS} }
        }
      }`,
      { input },
    );
    if (!data.issueCreate.success || !data.issueCreate.issue) {
      throw new LinearApiError("issueCreate returned success=false", 200, data);
    }
    return data.issueCreate.issue;
  }

  async updateIssue(
    id: string,
    input: {
      title?: string | undefined;
      description?: string | undefined;
      stateId?: string | undefined;
      parentId?: string | undefined;
    },
  ): Promise<LinearIssue> {
    const data = await this.gql<{
      issueUpdate: { success: boolean; issue: LinearIssue | null };
    }>(
      `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue { ${ISSUE_FIELDS} }
        }
      }`,
      { id, input },
    );
    if (!data.issueUpdate.success || !data.issueUpdate.issue) {
      throw new LinearApiError("issueUpdate returned success=false", 200, data);
    }
    return data.issueUpdate.issue;
  }

  async createComment(issueId: string, body: string): Promise<{ id: string }> {
    const data = await this.gql<{
      commentCreate: { success: boolean; comment: { id: string } | null };
    }>(
      `mutation CreateComment($input: CommentCreateInput!) {
        commentCreate(input: $input) {
          success
          comment { id }
        }
      }`,
      { input: { issueId, body } },
    );
    if (!data.commentCreate.success || !data.commentCreate.comment) {
      throw new LinearApiError("commentCreate returned success=false", 200, data);
    }
    return data.commentCreate.comment;
  }

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await this.opts.http.fetch(this.opts.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.opts.apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });

    const text = await res.text();
    let json: unknown;
    try {
      json = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      throw new LinearApiError(`Linear returned non-JSON response`, res.status, text);
    }

    if (!res.ok) {
      throw new LinearApiError(`Linear HTTP ${res.status}`, res.status, json);
    }

    const body = json as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors && body.errors.length > 0) {
      const message = body.errors.map((e) => e.message).join("; ");
      this.opts.logger.warn("Linear GraphQL error", { message, query: query.slice(0, 80) });
      throw new LinearApiError(message, res.status, body);
    }
    if (!body.data) {
      throw new LinearApiError("Linear response missing data", res.status, body);
    }
    return body.data;
  }
}
