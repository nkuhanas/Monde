# Backup Verification And Restore Rehearsal

Monde's operational source of truth is its local SQLite database. Back it up
independently of TeaParty's domain database and staged artifact storage.

## Create And Verify

```bash
monde backup create
monde backup list
monde backup verify <backup.sqlite>
```

Creation uses SQLite's online backup API, includes committed WAL state, checks
SQLite integrity and foreign keys, and records:

```text
schema version
byte size
SHA-256
integrity status
creation time
source and backup paths
```

Verification recalculates the checksum and runs `PRAGMA integrity_check` and
`PRAGMA foreign_key_check`.

## Isolated Rehearsal

```bash
monde backup rehearse <backup.sqlite> \
  --destination /an/explicit/new/monde-restore-rehearsal
```

The destination:

- is required
- must not already exist
- must be outside the live Monde data directory
- receives a user-only `monde.sqlite`
- receives `restore-rehearsal.json` with source and restored verification

The command never replaces or opens the live database for writing. Repeating
the same destination is refused.

## Data Boundary

The database backup contains operational SQLite state. Run-scope scratch
directories are stored outside SQLite under the Monde data directory and are
not copied by `backup create`.

Prompt and event payloads are retained in the operational database under the
current retention model, so they are included in database backups. This
progression does not claim prompt/event redaction or selective backup
exclusion.

TeaParty should back up separately:

- TeaParty domain state
- queue and lease state
- workflow state
- staged artifact bytes and admitted Assets

Monde backups cover only Monde operational state and immutable manifest
references.
