# sf-access-docs

Explore what is directly granted to a profile, permission set, permission set group or user in a Salesforce org.
Read-only. Uses the `sf` CLI session, so any org you can `sf org login` to works.

License: MIT.

## Quick start

You need [Node.js 20+](https://nodejs.org) and the [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`npm install -g @salesforce/cli`).

```bash
git clone https://github.com/adivaste-exceller/sf-access.git
cd sf-access
npm run setup                          # installs, builds, then checks your machine

sf org login web --alias myorg         # once per org (add --instance-url https://test.salesforce.com for a sandbox)

npm run extract                        # asks which org, reads it (read-only), saves a snapshot
npm start                              # opens the explorer in your browser
```

`npm run all` does the last two steps in one go.

### Commands

| Command | What it does |
|---|---|
| `npm run setup` | `npm install`, build, then `doctor`. |
| `npm run doctor` | Checks Node, the `sf` CLI, org logins and the build, and prints how to fix anything missing. |
| `npm run extract` | Lists the orgs you are logged in to and asks which one. Production orgs are marked. Pass `-- --target-org <alias>` to skip the question. |
| `npm start` | Opens the only snapshot, or asks which one if you have several. Pass `-- --snapshot <name>` to choose. If the port is busy it uses the next free one. |
| `npm run all` | `extract`, then `start`. |

Extra flags go after `--`, for example `npm run extract -- --metadata`.

### Where snapshots go

Always `<repo>/snapshots/<org-alias>/`, whichever folder you run the command from. Set `SF_ACCESS_DOCS_HOME` to use another
location. **Snapshots contain your org's users and access data. They are gitignored: never commit or share them.**

### Troubleshooting

| Problem | Fix |
|---|---|
| `sf` not found | `npm install -g @salesforce/cli`, then open a new terminal. |
| No orgs listed, or "re-login needed" | `sf org login web --alias <name>`. |
| `No snapshots ... Run "npm run extract"` | Run `npm run extract` first. |
| `UI is not built` | `npm run build`. |
| `INSUFFICIENT_ACCESS` or empty results | The user you logged in as needs API Enabled and View Setup and Configuration (a System Administrator profile has both). |
| Port 4780 busy | Nothing to do: the next free port is used and printed. |

### Flags for `extract`

| Flag | Effect |
|---|---|
| `--fields` | Also extract field-level permissions. Large and slow, off by default. |
| `--include-portal` | Include portal/community/guest profiles and users. Off by default. |
| `--detect-tests` | Read Apex class bodies to flag test classes exactly (default: guess from the name). |
| `--metadata` | Retrieve metadata (read-only, into a temp folder that is deleted afterwards) to trace screen flows and LWCs. Takes a few minutes. |
| `--keep-metadata <dir>` | Same, but keep the retrieved files in `<dir>`. |
| `--concurrency <n>` | Parallel API requests (1-12, default 6). |
| `--out <dir>` | Snapshot folder. |

## How it works

`extract` gets a token from `sf org auth show-access-token`, then runs paginated SOQL in parallel against
`PermissionSet`, `PermissionSetGroup(+Component)`, `ObjectPermissions`, `SetupEntityAccess`, `PermissionSetTabSetting`,
`User`, `PermissionSetAssignment`, `UserRole` and `EntityDefinition` (org-wide defaults). Results are stored as compact JSON.
`serve` shows them in a static UI that resolves effective access (groups, muting, user union) in the browser.

### Triggers and flows

These are not granted to anyone, so they are derived from object access: a trigger or record-triggered flow is listed
when the selection has Create (insert), Edit (update) or Delete (delete/undelete) on its object, or Modify All Data.
Rows mean "can fire". Entry conditions and trigger logic are not evaluated. Active only by default (toggle in the UI).
Scheduled, platform-event and autolaunched flows are not shown per principal. Screen and other flows that *are*
granted appear under "Flows" with their type.

### Screen flows and LWCs by object (`--metadata`)

Entry points are not queryable with SOQL, so `--metadata` runs `sf project retrieve start` for QuickAction, Layout,
FlexiPage, Flow, LightningComponentBundle, AuraDefinitionBundle, ApexPage, CustomTab, CustomApplication and the
unmanaged custom buttons. Each way a user can reach an active screen flow, LWC or Aura component becomes a route:

- quick actions (object-specific or global), custom buttons and links, flow and LWC components on Lightning pages
  (record, app, home, utility bar), LWC/Aura tabs, and Visualforce pages that embed a flow
- routes are passed down through containers: subflows, LWC screen components in a flow, LWCs nested in LWCs or Aura,
  and components that embed a flow
- LWCs that nothing routes to get "inferred" routes from the objects they declare or import through the schema

For a selection, a route is listed when it can read the entry point's object (tabs and utility bars: when it has the
app), grouped under the object. Amber text flags a missing Run Flows permission or Apex class access. The view is
static: flows launched from a URL, Apex, Experience Cloud pages or a dynamic flow name in code are not visible, and
which layout or page a profile actually gets (assignment precedence) is not resolved.

The Screen flows and LWCs sections have their own toolbar: search (name, object, entry point), entry-type chips with
counts (quick action, tab, page, button, nested, inferred), group by object / entry type / none, hide rows with
warnings, and expand/collapse all. Long lists start collapsed. Toolbar state is remembered per org.

Not yet covered: sharing rules, record types, groups/queues membership, ER diagram, integrations.
