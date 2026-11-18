import { type RemoteTask, type TaskSourceAdapter, TaskSourceError } from "@agentdesk/task-source"
import { Effect, Schema } from "effect"
import { incrementalJql, type JiraError, type JiraIssue, makeJiraClient } from "./client"

const HttpsUrl = Schema.String.check(
  Schema.makeFilter((u: string) => {
    try {
      const url = new URL(u.trim())
      return url.protocol === "https:" || ["localhost", "127.0.0.1"].includes(url.hostname) || "Jira URL must use https"
    } catch {
      return `Invalid URL: ${u}`
    }
  })
)

export const JiraSettings = Schema.Struct({
  deployment: Schema.Literals(["cloud", "datacenter"]),
  baseUrl: HttpsUrl,
  /** Account email (Cloud basic auth) or username (DC; unused with PAT bearer). */
  principal: Schema.String,
  jql: Schema.NonEmptyString
}).check(
  Schema.makeFilter((s) => s.deployment !== "cloud" || s.principal.trim() !== "" || "Jira Cloud needs the account email as principal")
)
export type JiraSettings = typeof JiraSettings.Type

const toTask = (i: JiraIssue): RemoteTask => ({
  remoteId: i.id,
  key: i.key,
  url: i.url,
  title: i.title,
  description: i.description,
  status: i.status,
  statusCategory: i.statusCategory === "done" ? "done" : i.statusCategory === "indeterminate" ? "in_progress" : i.statusCategory === "new" ? "todo" : null,
  assignee: i.assignee,
  labels: i.labels,
  updatedAt: i.updated,
  raw: { priority: i.priority, issueType: i.issueType }
})

const toSourceError = (e: JiraError) => new TaskSourceError({ source: "jira", kind: e.kind, message: e.message, status: e.status })

/** Jira Cloud / Data Center as a read-only task source, scoped by JQL. */
export const jiraSource: TaskSourceAdapter<JiraSettings> = {
  id: "jira",
  displayName: "Jira",
  description: "Import issues matching a JQL query from Jira Cloud or Data Center (read-only). One connection can span many Jira projects.",
  settings: JiraSettings,
  fields: [
    {
      key: "deployment",
      label: "Deployment",
      type: "select",
      required: true,
      default: "cloud",
      options: [
        { value: "cloud", label: "Jira Cloud (email + API token)" },
        { value: "datacenter", label: "Data Center (personal access token)" }
      ],
      hint: "Confirm whether your organization uses Cloud or Data Center."
    },
    { key: "baseUrl", label: "Site URL", type: "url", required: true, placeholder: "https://your-org.atlassian.net" },
    { key: "principal", label: "Account email (Cloud) / username (DC)", type: "text" },
    {
      key: "jql",
      label: "JQL scope",
      type: "textarea",
      required: true,
      default: "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
      hint: "Only issues matching this query are imported. It may span several Jira projects; you assign each imported ticket to an AgentDesk project."
    }
  ],
  credential: { label: "API token / personal access token", hint: "Stored in the OS credential store.", required: true },
  connect: (settings, credential, options = {}) => {
    const client = Effect.suspend(() =>
      credential
        ? Effect.succeed(
            makeJiraClient({
              deployment: settings.deployment,
              baseUrl: settings.baseUrl.trim().replace(/\/+$/, ""),
              principal: settings.principal,
              token: credential,
              fetch: options.fetch,
              retryBaseMs: options.retryBaseMs
            })
          )
        : Effect.fail(new TaskSourceError({ source: "jira", kind: "config", message: "No API token stored for this Jira connection" }))
    )
    return {
      test: client.pipe(
        Effect.flatMap((c) => c.myself.pipe(Effect.mapError(toSourceError))),
        Effect.map((me) => `Authenticated as ${me.displayName}`)
      ),
      fetchPage: ({ since, cursor }) =>
        client.pipe(
          Effect.flatMap((c) =>
            c.searchPage(since ? incrementalJql(settings.jql, since) : settings.jql, cursor).pipe(Effect.mapError(toSourceError))
          ),
          Effect.map((page) => ({ tasks: page.issues.map(toTask), cursor: page.cursor }))
        )
    }
  }
}
