# sf-access-docs

Explore what is directly granted to a profile, permission set, permission set group or user in a Salesforce org.
Read-only. Uses the `sf` CLI session, so any org you can `sf org login` to works.

## Use

```bash
npm install && npm run build
npm link                      # once: makes `sf-access-docs` available in any folder

sf-access-docs extract --target-org HoABL-UAT      # writes ./snapshots/HoABL-UAT
sf-access-docs serve --snapshot snapshots/HoABL-UAT
```

`--target-org` is required on purpose (no default org, so prod is never hit by accident).

| Flag | Effect |
|---|---|
| `--fields` | Also extract field-level permissions. Large and slow, off by default. |
| `--include-portal` | Include portal/community/guest profiles and users. Off by default. |
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

Not yet covered: sharing rules, record types, groups/queues membership, ER diagram, integrations.
