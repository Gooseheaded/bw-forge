import { Database } from "bun:sqlite";

export type SessionStatus = "active" | "closed";
export type MessageRole = "user" | "assistant" | "system";
export type TurnStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface Session {
  id: number;
  guildId: string;
  parentChannelId: string;
  threadId: string | null;
  creatorUserId: string;
  title: string | null;
  creationKey: string | null;
  status: SessionStatus;
  createdAt: string;
  lastActivityAt: string;
}

export interface StoredMessage {
  id: number;
  sessionId: number;
  discordMessageId: string | null;
  authorUserId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  rejected: boolean;
  turnId?: number | null;
}

export interface Turn {
  id: number;
  sessionId: number;
  triggeringMessageId: number;
  provider: string | null;
  model: string | null;
  status: TurnStatus;
  attemptCount: number;
  startedAt: string | null;
  completedAt: string | null;
  tokenUsage: number | null;
  error: string | null;
}

export interface StoreOptions {
  dbPath: string;
  maxQueuedPerThread?: number;
}
export interface ReserveSessionInput {
  guildId: string;
  parentChannelId: string;
  creatorUserId: string;
  title?: string;
  creationKey: string;
}
export interface EnqueueInput {
  sessionId: number;
  discordMessageId: string;
  authorUserId: string;
  content: string;
}

const now = () => new Date().toISOString();

function session(row: any): Session {
  return {
    id: row.id,
    guildId: row.guild_id,
    parentChannelId: row.parent_channel_id,
    threadId: row.thread_id,
    creatorUserId: row.creator_user_id,
    title: row.title,
    creationKey: row.creation_key,
    status: row.status,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
  };
}
function message(row: any): StoredMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    discordMessageId: row.discord_message_id,
    authorUserId: row.author_user_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    rejected: Boolean(row.rejected),
    turnId: row.turn_id ?? null,
  };
}
function turn(row: any): Turn {
  return {
    id: row.id,
    sessionId: row.session_id,
    triggeringMessageId: row.triggering_message_id,
    provider: row.provider,
    model: row.model,
    status: row.status,
    attemptCount: row.attempt_count,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    tokenUsage: row.token_usage,
    error: row.error,
  };
}

export class BotStore {
  readonly db: Database;
  readonly maxQueuedPerThread: number;
  constructor(options: StoreOptions) {
    this.db = new Database(options.dbPath);
    this.maxQueuedPerThread = options.maxQueuedPerThread ?? 100;
    try {
      const tables = this.db
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all() as { name: string }[];
      if (
        tables.length &&
        !tables.some((table) => table.name === "schema_version")
      ) {
        throw new Error(
          "DISCORD_BOT_DATABASE_PATH points to an existing non-bot database; use a separate bot state file.",
        );
      }
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version(version) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM schema_version);
    `);
    const version = (
      this.db.query("SELECT version FROM schema_version").get() as any
    ).version as number;
    if (version > 1)
      throw new Error(`Unsupported bot database schema version ${version}`);
    if (version < 1) {
      this.db.transaction(() =>
        this.db.exec(`
        CREATE TABLE sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, parent_channel_id TEXT NOT NULL,
          thread_id TEXT UNIQUE, creator_user_id TEXT NOT NULL, title TEXT, creation_key TEXT UNIQUE,
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed')),
          created_at TEXT NOT NULL, last_activity_at TEXT NOT NULL
        );
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES sessions(id),
          discord_message_id TEXT UNIQUE, author_user_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('user','assistant','system')), content TEXT NOT NULL,
          created_at TEXT NOT NULL, rejected INTEGER NOT NULL DEFAULT 0,
          turn_id INTEGER REFERENCES turns(id)
        );
        CREATE TABLE turns (
          id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES sessions(id),
          triggering_message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id),
          provider TEXT, model TEXT, status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
          attempt_count INTEGER NOT NULL DEFAULT 0, started_at TEXT, completed_at TEXT, token_usage INTEGER, error TEXT
        );
        CREATE TABLE delivery_attempts (
          id INTEGER PRIMARY KEY AUTOINCREMENT, turn_id INTEGER NOT NULL REFERENCES turns(id),
          chunk_index INTEGER NOT NULL, discord_message_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'pending',
          error TEXT, attempted_at TEXT, delivered_at TEXT, UNIQUE(turn_id, chunk_index)
        );
        CREATE INDEX turns_queue ON turns(session_id, status, id);
        CREATE UNIQUE INDEX turns_one_running_per_session ON turns(session_id) WHERE status='running';
        CREATE INDEX messages_session_order ON messages(session_id, id);
        CREATE UNIQUE INDEX messages_one_assistant_per_turn ON messages(turn_id) WHERE role='assistant';
        CREATE TABLE provider_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT, turn_id INTEGER NOT NULL REFERENCES turns(id),
          attempt INTEGER NOT NULL, started_at TEXT NOT NULL, completed_at TEXT,
          status TEXT NOT NULL CHECK(status IN ('running','completed','failed')), error TEXT,
          UNIQUE(turn_id, attempt)
        );
        UPDATE schema_version SET version = 1;
      `),
      )();
    }
    this.db
      .query(
        "UPDATE provider_requests SET status='failed',completed_at=?,error='process interrupted' WHERE status='running'",
      )
      .run(now());
    // A process interruption must never leave work permanently invisible.
    this.db
      .query(
        "UPDATE turns SET status='queued', started_at=NULL WHERE status='running' AND attempt_count < 3",
      )
      .run();
    // A response saved before an interruption is safe to deliver; only generation
    // attempts without a saved response are terminal failures.
    this.db
      .query(
        "UPDATE turns SET status='queued', started_at=NULL WHERE status='running' AND EXISTS (SELECT 1 FROM messages m WHERE m.turn_id=turns.id AND m.role='assistant')",
      )
      .run();
    const exhausted = this.db
      .query(
        "SELECT id,session_id FROM turns WHERE status='running' AND attempt_count >= 3 AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.turn_id=turns.id AND m.role='assistant')",
      )
      .all() as any[];
    for (const row of exhausted) {
      this.db
        .query(
          "INSERT INTO messages(session_id,author_user_id,role,content,created_at,turn_id,rejected) VALUES(?,?,?,?,?,?,1)",
        )
        .run(
          row.session_id,
          "bot",
          "assistant",
          "I couldn't complete that request after several attempts. Please try again.",
          now(),
          row.id,
        );
      this.db
        .query(
          "UPDATE turns SET status='queued',started_at=NULL,error='retry limit exceeded' WHERE id=?",
        )
        .run(row.id);
    }
  }
  reserveSession(input: ReserveSessionInput): Session {
    const existing = this.db
      .query("SELECT * FROM sessions WHERE creation_key=?")
      .get(input.creationKey) as any;
    if (existing) return session(existing);
    const time = now();
    this.db
      .query(
        `INSERT INTO sessions(guild_id,parent_channel_id,creator_user_id,title,creation_key,created_at,last_activity_at)
      VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        input.guildId,
        input.parentChannelId,
        input.creatorUserId,
        input.title ?? null,
        input.creationKey,
        time,
        time,
      );
    return session(
      this.db
        .query("SELECT * FROM sessions WHERE creation_key=?")
        .get(input.creationKey),
    );
  }
  attachThread(sessionId: number, threadId: string): Session {
    this.db
      .query(
        "UPDATE sessions SET thread_id=?, last_activity_at=? WHERE id=? AND (thread_id IS NULL OR thread_id=?)",
      )
      .run(threadId, now(), sessionId, threadId);
    const found = this.getSession(sessionId);
    if (!found) throw new Error("session not found");
    return found;
  }
  getSession(id: number): Session | null {
    const row = this.db
      .query("SELECT * FROM sessions WHERE id=?")
      .get(id) as any;
    return row ? session(row) : null;
  }
  getSessionByThread(threadId: string): Session | null {
    const row = this.db
      .query("SELECT * FROM sessions WHERE thread_id=?")
      .get(threadId) as any;
    return row ? session(row) : null;
  }
  addSystemMessage(sessionId: number, content: string): StoredMessage {
    const t = now();
    this.db
      .query(
        "INSERT INTO messages(session_id,author_user_id,role,content,created_at) VALUES(?,?,?,?,?)",
      )
      .run(sessionId, "bot", "system", content, t);
    return message(
      this.db
        .query("SELECT * FROM messages WHERE id=last_insert_rowid()")
        .get(),
    );
  }
  appendAssistantMessage(
    sessionId: number,
    turnId: number,
    content: string,
  ): StoredMessage {
    const existing = this.db
      .query("SELECT * FROM messages WHERE turn_id=? AND role='assistant'")
      .get(turnId) as any;
    if (existing) return message(existing);
    const t = now();
    this.db
      .query(
        "INSERT INTO messages(session_id,author_user_id,role,content,created_at,turn_id) VALUES(?,?,?,?,?,?)",
      )
      .run(sessionId, "bot", "assistant", content, t, turnId);
    return message(
      this.db
        .query("SELECT * FROM messages WHERE id=last_insert_rowid()")
        .get(),
    );
  }
  enqueueUserMessage(input: EnqueueInput): {
    message: StoredMessage;
    turn: Turn;
    duplicate: boolean;
  } {
    const duplicate = this.db
      .query("SELECT * FROM messages WHERE discord_message_id=?")
      .get(input.discordMessageId) as any;
    if (duplicate) {
      const t = this.db
        .query("SELECT * FROM turns WHERE triggering_message_id=?")
        .get(duplicate.id) as any;
      if (!t) throw new Error("duplicate message has no turn");
      return { message: message(duplicate), turn: turn(t), duplicate: true };
    }
    const transaction = this.db.transaction(() => {
      const session = this.db
        .query("SELECT status,thread_id FROM sessions WHERE id=?")
        .get(input.sessionId) as any;
      if (!session || session.status !== "active" || !session.thread_id)
        throw new Error("session is not active");
      const count = (
        this.db
          .query(
            `SELECT count(*) AS n FROM turns WHERE session_id=? AND status='queued'`,
          )
          .get(input.sessionId) as any
      ).n;
      if (count >= this.maxQueuedPerThread)
        throw new Error("session message queue is full");
      const t = now();
      this.db
        .query(
          "INSERT INTO messages(session_id,discord_message_id,author_user_id,role,content,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          input.sessionId,
          input.discordMessageId,
          input.authorUserId,
          "user",
          input.content,
          t,
        );
      const msg = this.db
        .query("SELECT * FROM messages WHERE id=last_insert_rowid()")
        .get() as any;
      this.db
        .query(
          "INSERT INTO turns(session_id,triggering_message_id,status) VALUES(?,?, 'queued')",
        )
        .run(input.sessionId, msg.id);
      const createdTurn = this.db
        .query("SELECT * FROM turns WHERE id=last_insert_rowid()")
        .get() as any;
      this.db
        .query("UPDATE sessions SET last_activity_at=? WHERE id=?")
        .run(t, input.sessionId);
      return {
        message: message(msg),
        turn: turn(createdTurn),
        duplicate: false,
      };
    });
    try {
      return transaction();
    } catch (e: any) {
      // A concurrent redelivery can race the unique Discord id.
      const msg = this.db
        .query("SELECT * FROM messages WHERE discord_message_id=?")
        .get(input.discordMessageId) as any;
      if (msg)
        return {
          message: message(msg),
          turn: turn(
            this.db
              .query("SELECT * FROM turns WHERE triggering_message_id=?")
              .get(msg.id),
          ),
          duplicate: true,
        };
      throw e;
    }
  }
  getMessage(id: number): StoredMessage | null {
    const row = this.db
      .query("SELECT * FROM messages WHERE id=?")
      .get(id) as any;
    return row ? message(row) : null;
  }
  getAssistantForTurn(turnId: number): StoredMessage | null {
    const row = this.db
      .query(
        "SELECT * FROM messages WHERE turn_id=? AND role='assistant' ORDER BY id DESC LIMIT 1",
      )
      .get(turnId) as any;
    return row ? message(row) : null;
  }
  getMessages(sessionId: number): StoredMessage[] {
    return (
      this.db
        .query("SELECT * FROM messages WHERE session_id=? ORDER BY id")
        .all(sessionId) as any[]
    ).map(message);
  }
  getMessageByDiscordId(discordMessageId: string): StoredMessage | null {
    const row = this.db
      .query("SELECT * FROM messages WHERE discord_message_id=?")
      .get(discordMessageId) as any;
    return row ? message(row) : null;
  }
  getConversationHistory(
    sessionId: number,
    beforeMessageId?: number,
    limit = 200,
  ): StoredMessage[] {
    const cutoff = beforeMessageId ?? Number.MAX_SAFE_INTEGER;
    const rows = this.db
      .query(
        `WITH eligible AS (
        SELECT m.*, CASE WHEN m.role='user' THEN m.id ELSE t.triggering_message_id END AS trigger_id
        FROM messages m LEFT JOIN turns t ON t.triggering_message_id=m.id OR t.id=m.turn_id
        WHERE m.session_id=? AND m.rejected=0 AND m.role IN ('user','assistant')
          AND (m.role='assistant' AND t.status='completed' OR m.role='user' AND t.status='completed')
          AND (CASE WHEN m.role='user' THEN m.id ELSE t.triggering_message_id END)<?
      ), recent_triggers AS (
        SELECT DISTINCT trigger_id FROM eligible ORDER BY trigger_id DESC LIMIT ?
      )
      SELECT eligible.* FROM eligible JOIN recent_triggers USING(trigger_id)
      ORDER BY trigger_id, CASE role WHEN 'user' THEN 0 ELSE 1 END, id`,
      )
      .all(sessionId, cutoff, limit);
    return (rows as any[]).map(message);
  }
  claimNextTurn(
    sessionId?: number,
    provider?: string,
    model?: string,
  ): Turn | null {
    const tx = this.db.transaction(() => {
      const row = (
        sessionId === undefined
          ? this.db
              .query(
                "SELECT * FROM turns q WHERE q.status='queued' AND NOT EXISTS (SELECT 1 FROM turns r WHERE r.session_id=q.session_id AND r.status='running') ORDER BY q.id LIMIT 1",
              )
              .get()
          : this.db
              .query(
                "SELECT * FROM turns q WHERE q.session_id=? AND q.status='queued' AND NOT EXISTS (SELECT 1 FROM turns r WHERE r.session_id=q.session_id AND r.status='running') ORDER BY q.id LIMIT 1",
              )
              .get(sessionId)
      ) as any;
      if (!row) return null;
      const owningSession = this.db
        .query("SELECT status,thread_id FROM sessions WHERE id=?")
        .get(row.session_id) as any;
      if (
        !owningSession ||
        owningSession.status !== "active" ||
        !owningSession.thread_id
      )
        return null;
      if (sessionId !== undefined) {
        const active = this.db
          .query(
            "SELECT 1 FROM turns WHERE session_id=? AND status='running' LIMIT 1",
          )
          .get(sessionId);
        if (active) return null;
      }
      const updated = this.db
        .query(
          "UPDATE turns SET status='running',attempt_count=attempt_count+1,started_at=?,provider=?,model=? WHERE id=? AND status='queued'",
        )
        .run(now(), provider ?? null, model ?? null, row.id);
      if (updated.changes !== 1) return null;
      return turn(this.db.query("SELECT * FROM turns WHERE id=?").get(row.id));
    });
    return tx();
  }
  saveTurnResponse(
    turnId: number,
    response: {
      text: string;
      provider?: string;
      model?: string;
      tokenUsage?: number;
    },
  ) {
    const tx = this.db.transaction(() => {
      const t = this.db
        .query("SELECT session_id FROM turns WHERE id=?")
        .get(turnId) as any;
      if (!t) throw new Error("turn not found");
      this.appendAssistantMessage(t.session_id, turnId, response.text);
      this.db
        .query(
          "UPDATE turns SET provider=COALESCE(?,provider),model=COALESCE(?,model),token_usage=COALESCE(?,token_usage) WHERE id=?",
        )
        .run(
          response.provider ?? null,
          response.model ?? null,
          response.tokenUsage ?? null,
          turnId,
        );
    });
    tx();
  }
  completeTurn(turnId: number, tokenUsage?: number) {
    this.db
      .query(
        "UPDATE turns SET status='completed',completed_at=?,token_usage=COALESCE(?,token_usage),error=NULL WHERE id=? AND status='running'",
      )
      .run(now(), tokenUsage ?? null, turnId);
  }
  failTurn(turnId: number, error: string, retry = true) {
    const row = this.db
      .query("SELECT attempt_count FROM turns WHERE id=?")
      .get(turnId) as any;
    if (!row) return;
    const retryable = retry && row.attempt_count < 3;
    this.db
      .query(
        "UPDATE turns SET status=?,completed_at=?,error=? WHERE id=? AND status='running'",
      )
      .run(
        retryable ? "queued" : "failed",
        retryable ? null : now(),
        error.slice(0, 2000),
        turnId,
      );
  }
  startProviderRequest(turnId: number): number {
    const row = this.db
      .query("SELECT attempt_count FROM turns WHERE id=?")
      .get(turnId) as any;
    if (!row) throw new Error("turn not found");
    const attempt = row.attempt_count;
    this.db
      .query(
        "INSERT INTO provider_requests(turn_id,attempt,started_at,status) VALUES(?,?,?,'running')",
      )
      .run(turnId, attempt, now());
    return attempt;
  }
  finishProviderRequest(
    turnId: number,
    attempt: number,
    status: "completed" | "failed",
    error?: string,
  ) {
    this.db
      .query(
        "UPDATE provider_requests SET status=?,completed_at=?,error=? WHERE turn_id=? AND attempt=?",
      )
      .run(status, now(), error?.slice(0, 2000) ?? null, turnId, attempt);
  }
  cancelTurn(turnId: number, reason = "authorization revoked") {
    this.db
      .query(
        "UPDATE turns SET status='cancelled',completed_at=?,error=? WHERE id=? AND status IN ('queued','running')",
      )
      .run(now(), reason, turnId);
    const row = this.db
      .query("SELECT triggering_message_id FROM turns WHERE id=?")
      .get(turnId) as any;
    if (row)
      this.db
        .query("UPDATE messages SET rejected=1 WHERE id=?")
        .run(row.triggering_message_id);
  }
  getTurn(id: number): Turn | null {
    const row = this.db.query("SELECT * FROM turns WHERE id=?").get(id) as any;
    return row ? turn(row) : null;
  }
  getPendingTurns(): Turn[] {
    return (
      this.db
        .query(
          "SELECT t.* FROM turns t JOIN sessions s ON s.id=t.session_id WHERE t.status='queued' AND s.status='active' AND s.thread_id IS NOT NULL ORDER BY t.id",
        )
        .all() as any[]
    ).map(turn);
  }
  recordDeliveryAttempt(
    turnId: number,
    chunkIndex: number,
    discordMessageId?: string,
  ) {
    this.db
      .query(
        `INSERT INTO delivery_attempts(turn_id,chunk_index,discord_message_id,attempts,status,attempted_at) VALUES(?,?,?,1,'pending',?) ON CONFLICT(turn_id,chunk_index) DO UPDATE SET attempted_at=excluded.attempted_at, attempts=delivery_attempts.attempts+1, discord_message_id=COALESCE(excluded.discord_message_id,delivery_attempts.discord_message_id)`,
      )
      .run(turnId, chunkIndex, discordMessageId ?? null, now());
  }
  markDeliveryDelivered(
    turnId: number,
    chunkIndex: number,
    discordMessageId: string,
  ) {
    this.db
      .query(
        "UPDATE delivery_attempts SET status='delivered',discord_message_id=?,delivered_at=? WHERE turn_id=? AND chunk_index=?",
      )
      .run(discordMessageId, now(), turnId, chunkIndex);
  }
  getDelivery(
    turnId: number,
  ): { chunkIndex: number; discordMessageId: string | null; status: string }[] {
    return this.db
      .query(
        "SELECT chunk_index AS chunkIndex,discord_message_id AS discordMessageId,status FROM delivery_attempts WHERE turn_id=? ORDER BY chunk_index",
      )
      .all(turnId) as any[];
  }
  getPendingDeliveries(): {
    turnId: number;
    chunkIndex: number;
    discordMessageId: string | null;
  }[] {
    return this.db
      .query(
        "SELECT turn_id AS turnId,chunk_index AS chunkIndex,discord_message_id AS discordMessageId FROM delivery_attempts WHERE status!='delivered' ORDER BY turn_id,chunk_index",
      )
      .all() as any[];
  }
  close() {
    this.db.close();
  }
}

export type { Database };
