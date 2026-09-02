//! SQLite-backed repository for persistent application data.
//!
//! Sessions and folders are stored with their structured columns indexed for
//! search, plus a `payload` JSON blob carrying the full [`Session`] so the
//! schema can evolve without a migration for every new field. A simple
//! `user_version`-based migration runner keeps the schema current.

use hampy_core::model::{Session, SessionId};
use hampy_core::{Error, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// A folder with optional display color. The `name` doubles as the primary key
/// so sessions can reference folders by name without a separate UUID join.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderRecord {
    pub name: String,
    /// CSS color string (e.g. `"#faff69"`), or `None` for the default accent.
    pub color: Option<String>,
    /// Name of the parent folder, or `None` for a root-level folder.
    pub parent_id: Option<String>,
}

/// Ordered DDL migrations. The index + 1 becomes the SQLite `user_version`.
const MIGRATIONS: &[&str] = &[
    // v1 — initial schema.
    r#"
    CREATE TABLE folders (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        parent_id   TEXT
    );
    CREATE TABLE sessions (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        protocol    TEXT NOT NULL,
        folder_id   TEXT,
        favorite    INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        payload     TEXT NOT NULL
    );
    CREATE INDEX idx_sessions_name ON sessions(name);
    CREATE INDEX idx_sessions_protocol ON sessions(protocol);
    CREATE TABLE history (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL,
        opened_at   TEXT NOT NULL
    );
    "#,
    // v2 — add display color to folders.
    "ALTER TABLE folders ADD COLUMN color TEXT;",
];

/// Thread-confined SQLite repository. Wrap in a `Mutex`/dedicated task when
/// shared across threads (the Tauri layer keeps it behind an async mutex).
pub struct Store {
    conn: Connection,
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Store").finish_non_exhaustive()
    }
}

impl Store {
    /// Open (creating if needed) the database at `path` and run migrations.
    pub fn open(path: impl AsRef<std::path::Path>) -> Result<Self> {
        let conn = Connection::open(path).map_err(map_db)?;
        Self::from_connection(conn)
    }

    /// Open an in-memory database — used by tests.
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().map_err(map_db)?;
        Self::from_connection(conn)
    }

    fn from_connection(conn: Connection) -> Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(map_db)?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(map_db)?;
        let mut store = Store { conn };
        store.migrate()?;
        Ok(store)
    }

    /// Apply any migrations not yet reflected in `user_version`.
    fn migrate(&mut self) -> Result<()> {
        let current: i64 = self
            .conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(map_db)?;
        for (idx, ddl) in MIGRATIONS.iter().enumerate() {
            let version = (idx + 1) as i64;
            if version > current {
                self.conn.execute_batch(ddl).map_err(map_db)?;
                self.conn
                    .pragma_update(None, "user_version", version)
                    .map_err(map_db)?;
                tracing::info!(version, "applied database migration");
            }
        }
        Ok(())
    }

    /// Insert or replace a session.
    pub fn upsert_session(&self, session: &Session) -> Result<()> {
        let payload = serde_json::to_string(session)?;
        self.conn
            .execute(
                "INSERT INTO sessions (id, name, protocol, folder_id, favorite, last_used_at, payload)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET
                    name=excluded.name, protocol=excluded.protocol,
                    folder_id=excluded.folder_id, favorite=excluded.favorite,
                    last_used_at=excluded.last_used_at, payload=excluded.payload",
                params![
                    session.id.to_string(),
                    session.name,
                    session.protocol.subsystem(),
                    session.folder_id.clone(),
                    session.favorite as i64,
                    session.last_used_at.map(|t| t.to_rfc3339()),
                    payload,
                ],
            )
            .map_err(map_db)?;
        Ok(())
    }

    /// Fetch a single session by id.
    pub fn get_session(&self, id: SessionId) -> Result<Option<Session>> {
        let payload: Option<String> = self
            .conn
            .query_row(
                "SELECT payload FROM sessions WHERE id = ?1",
                params![id.to_string()],
                |row| row.get(0),
            )
            .optional()
            .map_err(map_db)?;
        match payload {
            Some(json) => Ok(Some(serde_json::from_str(&json)?)),
            None => Ok(None),
        }
    }

    /// List all sessions ordered by name.
    pub fn list_sessions(&self) -> Result<Vec<Session>> {
        let mut stmt = self
            .conn
            .prepare("SELECT payload FROM sessions ORDER BY name COLLATE NOCASE")
            .map_err(map_db)?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(map_db)?;
        let mut out = Vec::new();
        for row in rows {
            let json = row.map_err(map_db)?;
            out.push(serde_json::from_str(&json)?);
        }
        Ok(out)
    }

    /// Delete a session; errors if it does not exist.
    pub fn delete_session(&self, id: SessionId) -> Result<()> {
        let affected = self
            .conn
            .execute(
                "DELETE FROM sessions WHERE id = ?1",
                params![id.to_string()],
            )
            .map_err(map_db)?;
        if affected == 0 {
            return Err(Error::NotFound(format!("session {id}")));
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Folders
    // -----------------------------------------------------------------------

    /// Insert or update a folder record. `name` is the primary key; calling
    /// this with an existing name updates its color.
    pub fn upsert_folder(&self, record: &FolderRecord) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO folders (id, name, color, parent_id) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET
                    name=excluded.name, color=excluded.color, parent_id=excluded.parent_id",
                params![record.name, record.name, record.color, record.parent_id],
            )
            .map_err(map_db)?;
        Ok(())
    }

    /// List all persisted folder records ordered by name.
    pub fn list_folders(&self) -> Result<Vec<FolderRecord>> {
        let mut stmt = self
            .conn
            .prepare("SELECT name, color, parent_id FROM folders ORDER BY name COLLATE NOCASE")
            .map_err(map_db)?;
        let rows = stmt
            .query_map([], |row| {
                Ok(FolderRecord {
                    name: row.get(0)?,
                    color: row.get(1)?,
                    parent_id: row.get(2)?,
                })
            })
            .map_err(map_db)?;
        rows.map(|r| r.map_err(map_db)).collect()
    }

    /// Delete a folder record by name. Sessions that referenced it keep their
    /// `folder_id`; the caller is responsible for moving them first.
    pub fn delete_folder(&self, name: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM folders WHERE id = ?1", params![name])
            .map_err(map_db)?;
        Ok(())
    }

    /// Rename a folder: carries over its color, updates every session's
    /// `folder_id` column and JSON payload, then removes the old record.
    /// The three statements are not wrapped in an explicit transaction because
    /// `rusqlite::Connection::transaction` requires `&mut self`, which is
    /// incompatible with the shared `&self` pattern used here. Rename is a
    /// rare, user-initiated operation; partial state (new folder exists, some
    /// sessions still point to old name) is recoverable by renaming again.
    pub fn rename_folder(&self, old_name: &str, new_name: &str) -> Result<()> {
        if old_name == new_name {
            return Ok(());
        }
        // 1. Create the new folder record, inheriting color and parent_id.
        self.conn
            .execute(
                "INSERT OR REPLACE INTO folders (id, name, color, parent_id)
                 SELECT ?2, ?2, color, parent_id FROM folders WHERE id = ?1",
                params![old_name, new_name],
            )
            .map_err(map_db)?;
        // 2. Update sessions: indexed column + JSON payload in one shot.
        self.conn
            .execute(
                "UPDATE sessions
                 SET folder_id = ?2,
                     payload   = json_set(payload, '$.folder_id', ?2)
                 WHERE folder_id = ?1",
                params![old_name, new_name],
            )
            .map_err(map_db)?;
        // 3. Re-parent any sub-folders that pointed to the old name.
        self.conn
            .execute(
                "UPDATE folders SET parent_id = ?2 WHERE parent_id = ?1",
                params![old_name, new_name],
            )
            .map_err(map_db)?;
        // 4. Remove the old folder record.
        self.conn
            .execute("DELETE FROM folders WHERE id = ?1", params![old_name])
            .map_err(map_db)?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // History
    // -----------------------------------------------------------------------

    /// Record that a session was opened (for history/recents).
    pub fn record_open(&self, id: SessionId) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO history (session_id, opened_at) VALUES (?1, ?2)",
                params![id.to_string(), chrono::Utc::now().to_rfc3339()],
            )
            .map_err(map_db)?;
        Ok(())
    }
}

fn map_db(e: rusqlite::Error) -> Error {
    Error::Persistence(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use hampy_core::model::Protocol;

    #[test]
    fn upsert_get_list_delete_cycle() {
        let store = Store::open_in_memory().unwrap();
        let mut session = Session::new("prod-db", Protocol::Ssh);
        session.favorite = true;

        store.upsert_session(&session).unwrap();
        let fetched = store.get_session(session.id).unwrap().unwrap();
        assert_eq!(fetched.name, "prod-db");
        assert!(fetched.favorite);

        assert_eq!(store.list_sessions().unwrap().len(), 1);

        store.record_open(session.id).unwrap();
        store.delete_session(session.id).unwrap();
        assert!(store.get_session(session.id).unwrap().is_none());
        assert!(store.delete_session(session.id).is_err());
    }

    #[test]
    fn folder_upsert_list_delete() {
        let store = Store::open_in_memory().unwrap();

        store
            .upsert_folder(&FolderRecord {
                name: "servers".into(),
                color: Some("#faff69".into()),
                parent_id: None,
            })
            .unwrap();
        store
            .upsert_folder(&FolderRecord {
                name: "dev".into(),
                color: None,
                parent_id: None,
            })
            .unwrap();

        let folders = store.list_folders().unwrap();
        assert_eq!(folders.len(), 2);
        assert_eq!(folders[0].name, "dev");
        assert_eq!(folders[1].name, "servers");
        assert_eq!(folders[1].color.as_deref(), Some("#faff69"));

        // Upsert updates color in place.
        store
            .upsert_folder(&FolderRecord {
                name: "servers".into(),
                color: None,
                parent_id: None,
            })
            .unwrap();
        let updated = store.list_folders().unwrap();
        assert!(updated
            .iter()
            .find(|f| f.name == "servers")
            .unwrap()
            .color
            .is_none());

        store.delete_folder("dev").unwrap();
        assert_eq!(store.list_folders().unwrap().len(), 1);
    }

    #[test]
    fn folder_rename_updates_sessions() {
        let store = Store::open_in_memory().unwrap();

        store
            .upsert_folder(&FolderRecord {
                name: "old".into(),
                color: Some("#ff0000".into()),
                parent_id: None,
            })
            .unwrap();

        let mut s1 = Session::new("host-1", Protocol::Ssh);
        s1.folder_id = Some("old".into());
        let mut s2 = Session::new("host-2", Protocol::Ssh);
        s2.folder_id = Some("old".into());
        store.upsert_session(&s1).unwrap();
        store.upsert_session(&s2).unwrap();

        store.rename_folder("old", "new").unwrap();

        // Folder record renamed and color carried over.
        let folders = store.list_folders().unwrap();
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].name, "new");
        assert_eq!(folders[0].color.as_deref(), Some("#ff0000"));

        // All sessions updated in both column and JSON payload.
        let sessions = store.list_sessions().unwrap();
        assert!(sessions
            .iter()
            .all(|s| s.folder_id.as_deref() == Some("new")));
    }
}
