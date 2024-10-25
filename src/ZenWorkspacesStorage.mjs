var ZenWorkspacesStorage = {
  async init() {
    console.log('ZenWorkspacesStorage: Initializing...');
    await this._ensureTable();
  },

  async _ensureTable() {
    await PlacesUtils.withConnectionWrapper('ZenWorkspacesStorage._ensureTable', async (db) => {
      // Create the main workspaces table if it doesn't exist
      await db.execute(`
        CREATE TABLE IF NOT EXISTS zen_workspaces (
          id INTEGER PRIMARY KEY,
          uuid TEXT UNIQUE NOT NULL,
          name TEXT NOT NULL,
          icon TEXT,
          is_default INTEGER NOT NULL DEFAULT 0,
          container_id INTEGER,
          position INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);

      // Create an index on the uuid column
      await db.execute(`
        CREATE INDEX IF NOT EXISTS idx_zen_workspaces_uuid ON zen_workspaces(uuid)
      `);

      // Create the changes tracking table if it doesn't exist
      await db.execute(`
        CREATE TABLE IF NOT EXISTS zen_workspaces_changes (
          uuid TEXT PRIMARY KEY,
          timestamp INTEGER NOT NULL
        )
      `);

      // Create an index on the uuid column for changes tracking table
      await db.execute(`
        CREATE INDEX IF NOT EXISTS idx_zen_workspaces_changes_uuid ON zen_workspaces_changes(uuid)
      `);

      // Create a workspace theme table if it doesn't exist, theme can be null
      await db.execute(`
        CREATE TABLE IF NOT EXISTS zen_workspace_themes (
          uuid TEXT PRIMARY KEY,
          json TEXT
        )
      `);
    });
  },

  async migrateWorkspacesFromJSON() {
    const oldWorkspacesPath = PathUtils.join(PathUtils.profileDir, 'zen-workspaces', 'Workspaces.json');
    if (await IOUtils.exists(oldWorkspacesPath)) {
      console.info('ZenWorkspacesStorage: Migrating workspaces from JSON...');
      const oldWorkspaces = await IOUtils.readJSON(oldWorkspacesPath);
      if (oldWorkspaces.workspaces) {
        for (const workspace of oldWorkspaces.workspaces) {
          await this.saveWorkspace(workspace);
        }
      }
      await IOUtils.remove(oldWorkspacesPath);
    }
  },

  /**
   * Private helper method to notify observers with a list of changed UUIDs.
   * @param {string} event - The observer event name.
   * @param {Array<string>} uuids - Array of changed workspace UUIDs.
   */
  _notifyWorkspacesChanged(event, uuids) {
    if (uuids.length === 0) return; // No changes to notify

    // Convert the array of UUIDs to a JSON string
    const data = JSON.stringify(uuids);

    Services.obs.notifyObservers(null, event, data);
  },

  async saveWorkspace(workspace, notifyObservers = true) {
    const changedUUIDs = new Set();

    await PlacesUtils.withConnectionWrapper('ZenWorkspacesStorage.saveWorkspace', async (db) => {
      await db.executeTransaction(async () => {
        const now = Date.now();

        // Handle default workspace
        if (workspace.default) {
          await db.execute(`UPDATE zen_workspaces SET is_default = 0 WHERE uuid != :uuid`, { uuid: workspace.uuid });
          const unsetDefaultRows = await db.execute(`SELECT uuid FROM zen_workspaces WHERE is_default = 0 AND uuid != :uuid`, { uuid: workspace.uuid });
          for (const row of unsetDefaultRows) {
            changedUUIDs.add(row.getResultByName('uuid'));
          }
        }

        let newPosition;
        if ('position' in workspace && Number.isFinite(workspace.position)) {
          newPosition = workspace.position;
        } else {
          // Get the maximum position
          const maxPositionResult = await db.execute(`SELECT MAX("position") as max_position FROM zen_workspaces`);
          const maxPosition = maxPositionResult[0].getResultByName('max_position') || 0;
          newPosition = maxPosition + 1000; // Add a large increment to avoid frequent reordering
        }

        // Insert or replace the workspace
        await db.executeCached(`
          INSERT OR REPLACE INTO zen_workspaces (
          uuid, name, icon, is_default, container_id, created_at, updated_at, "position"
        ) VALUES (
          :uuid, :name, :icon, :is_default, :container_id, 
          COALESCE((SELECT created_at FROM zen_workspaces WHERE uuid = :uuid), :now),
          :now,
          :position
        )
        `, {
          uuid: workspace.uuid,
          name: workspace.name,
          icon: workspace.icon || null,
          is_default: workspace.default ? 1 : 0,
          container_id: workspace.containerTabId || null,
          now,
          position: newPosition
        });

        // Record the change
        await db.execute(`
          INSERT OR REPLACE INTO zen_workspaces_changes (uuid, timestamp)
        VALUES (:uuid, :timestamp)
        `, {
          uuid: workspace.uuid,
          timestamp: Math.floor(now / 1000)
        });

        changedUUIDs.add(workspace.uuid);

        await this.updateLastChangeTimestamp(db);
      });
    });

    if (notifyObservers) {
      this._notifyWorkspacesChanged("zen-workspace-updated", Array.from(changedUUIDs));
    }
  },

  async getWorkspaces() {
    const db = await PlacesUtils.promiseDBConnection();
    const rows = await db.executeCached(`
      SELECT * FROM zen_workspaces ORDER BY created_at ASC
    `);
    return rows.map((row) => ({
      uuid: row.getResultByName('uuid'),
      name: row.getResultByName('name'),
      icon: row.getResultByName('icon'),
      default: !!row.getResultByName('is_default'),
      containerTabId: row.getResultByName('container_id'),
      position: row.getResultByName('position'),
    }));
  },

  async removeWorkspace(uuid, notifyObservers = true) {
    const changedUUIDs = [uuid];

    await PlacesUtils.withConnectionWrapper('ZenWorkspacesStorage.removeWorkspace', async (db) => {
      await db.execute(
          `
            DELETE FROM zen_workspaces WHERE uuid = :uuid
          `,
          { uuid }
      );

      // Record the removal as a change
      const now = Date.now();
      await db.execute(`
        INSERT OR REPLACE INTO zen_workspaces_changes (uuid, timestamp)
        VALUES (:uuid, :timestamp)
      `, {
        uuid,
        timestamp: Math.floor(now / 1000)
      });

      await db.execute(`
        DELETE FROM zen_workspace_themes WHERE uuid = :uuid
      `, { uuid });

      await this.updateLastChangeTimestamp(db);
    });

    if (notifyObservers) {
      this._notifyWorkspacesChanged("zen-workspace-removed", changedUUIDs);
    }
  },

  async wipeAllWorkspaces() {
    await PlacesUtils.withConnectionWrapper('ZenWorkspacesStorage.wipeAllWorkspaces', async (db) => {
      await db.execute(`DELETE FROM zen_workspaces`);
      await db.execute(`DELETE FROM zen_workspaces_changes`);
      await this.updateLastChangeTimestamp(db);
    });
  },

  async setDefaultWorkspace(uuid, notifyObservers = true) {
    const changedUUIDs = [];

    await PlacesUtils.withConnectionWrapper('ZenWorkspacesStorage.setDefaultWorkspace', async (db) => {
      await db.executeTransaction(async () => {
        const now = Date.now();
        // Unset the default flag for all other workspaces
        await db.execute(`UPDATE zen_workspaces SET is_default = 0 WHERE uuid != :uuid`, { uuid });

        // Collect UUIDs of workspaces that were unset as default
        const unsetDefaultRows = await db.execute(`SELECT uuid FROM zen_workspaces WHERE is_default = 0 AND uuid != :uuid`, { uuid });
        for (const row of unsetDefaultRows) {
          changedUUIDs.push(row.getResultByName('uuid'));
        }

        // Set the default flag for the specified workspace
        await db.execute(`UPDATE zen_workspaces SET is_default = 1 WHERE uuid = :uuid`, { uuid });

        // Record the change for the specified workspace
        await db.execute(`
          INSERT OR REPLACE INTO zen_workspaces_changes (uuid, timestamp)
          VALUES (:uuid, :timestamp)
        `, {
          uuid,
          timestamp: Math.floor(now / 1000)
        });

        // Add the main workspace UUID to the changed set
        changedUUIDs.push(uuid);

        await this.updateLastChangeTimestamp(db);
      });
    });

    if (notifyObservers) {
      this._notifyWorkspacesChanged("zen-workspace-updated", changedUUIDs);
    }
  },

  async markChanged(uuid) {
    await PlacesUtils.withConnectionWrapper('ZenWorkspacesStorage.markChanged', async (db) => {
      const now = Date.now();
      await db.execute(`
        INSERT OR REPLACE INTO zen_workspaces_changes (uuid, timestamp)
        VALUES (:uuid, :timestamp)
      `, {
        uuid,
        timestamp: Math.floor(now / 1000)
      });
    });
  },

  async saveWorkspaceTheme(uuid, theme) {
    await PlacesUtils.withConnectionWrapper('ZenWorkspacesStorage.saveWorkspaceTheme', async (db) => {
      await db.execute(`
        INSERT OR REPLACE INTO zen_workspace_themes (uuid, json)
        VALUES (:uuid, :json)
      `, { uuid, json: JSON.stringify(theme) });
    });
  },

  async getWorkspaceTheme(uuid) {
    const db = await PlacesUtils.promiseDBConnection();
    const result = await db.executeCached(`
      SELECT json FROM zen_workspace_themes WHERE uuid = :uuid
    `, { uuid });
    return result.length ? JSON.parse(result[0].getResultByName('json')) : null;
  },

  async getChangedIDs() {
    const db = await PlacesUtils.promiseDBConnection();
    const rows = await db.execute(`
      SELECT uuid, timestamp FROM zen_workspaces_changes
    `);
    const changes = {};
    for (const row of rows) {
      changes[row.getResultByName('uuid')] = row.getResultByName('timestamp');
    }
    return changes;
  },

  async clearChangedIDs() {
    await PlacesUtils.withConnectionWrapper('ZenWorkspacesStorage.clearChangedIDs', async (db) => {
      await db.execute(`DELETE FROM zen_workspaces_changes`);
    });
  },

  shouldReorderWorkspaces(before, current, after) {
    const minGap = 1; // Minimum allowed gap between positions
    return (before !== null && current - before < minGap) || (after !== null && after - current < minGap);
  },

  async reorderAllWorkspaces(db, changedUUIDs) {
    const workspaces = await db.execute(`
      SELECT uuid
      FROM zen_workspaces
      ORDER BY "position" ASC
    `);

    for (let i = 0; i < workspaces.length; i++) {
      const newPosition = (i + 1) * 1000; // Use large increments
      await db.execute(`
        UPDATE zen_workspaces
        SET "position" = :newPosition
        WHERE uuid = :uuid
      `, { newPosition, uuid: workspaces[i].getResultByName('uuid') });
      changedUUIDs.add(workspaces[i].getResultByName('uuid'));
    }
  },

  async updateLastChangeTimestamp(db) {
    const now = Date.now();
    await db.execute(`
      INSERT OR REPLACE INTO moz_meta (key, value)
    VALUES ('zen_workspaces_last_change', :now)
    `, { now });
  },

  async getLastChangeTimestamp() {
    const db = await PlacesUtils.promiseDBConnection();
    const result = await db.executeCached(`
      SELECT value FROM moz_meta WHERE key = 'zen_workspaces_last_change'
    `);
    return result.length ? parseInt(result[0].getResultByName('value'), 10) : 0;
  },

  async updateWorkspacePositions(workspaces) {
    const changedUUIDs = new Set();

    await PlacesUtils.withConnectionWrapper('ZenWorkspacesStorage.updateWorkspacePositions', async (db) => {
      await db.executeTransaction(async () => {
        const now = Date.now();

        for (let i = 0; i < workspaces.length; i++) {
          const workspace = workspaces[i];
          const newPosition = (i + 1) * 1000;

          await db.execute(`
          UPDATE zen_workspaces
          SET "position" = :newPosition
          WHERE uuid = :uuid
        `, { newPosition, uuid: workspace.uuid });

          changedUUIDs.add(workspace.uuid);

          // Record the change
          await db.execute(`
          INSERT OR REPLACE INTO zen_workspaces_changes (uuid, timestamp)
          VALUES (:uuid, :timestamp)
        `, {
            uuid: workspace.uuid,
            timestamp: Math.floor(now / 1000)
          });
        }

        await this.updateLastChangeTimestamp(db);
      });
    });

    this._notifyWorkspacesChanged("zen-workspace-updated", Array.from(changedUUIDs));
  },
};
