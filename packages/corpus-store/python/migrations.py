"""Transactional additive revisions within Corpus v2; never migrate a legacy corpus."""
from pathlib import Path
import time


def require_v2(db):
    if db.execute('PRAGMA user_version').fetchone()[0] != 2:
        raise ValueError('Additive Corpus administration requires Corpus v2; v1 is never migrated')
    row = db.execute('SELECT schema_version,purpose,name_normalizer FROM corpus_metadata WHERE singleton=1').fetchone()
    if not row or tuple(row[:2]) != (2, 'corpus-store'):
        raise ValueError('Invalid Corpus v2 metadata')
    if row[2] != 'python-casefold-v1':
        raise ValueError('Unsupported name normalizer: ' + str(row[2]))


def migrate_in_transaction(db):
    if not db.in_transaction:
        raise ValueError('Migration requires an active transaction')
    require_v2(db)
    db.execute('''CREATE TABLE IF NOT EXISTS corpus_migrations (
        revision INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at_ms INTEGER NOT NULL
    ) STRICT''')
    if not db.execute('SELECT 1 FROM corpus_migrations WHERE revision=1').fetchone():
        for statement in Path(__file__).with_name('identities.sql').read_text().split(';'):
            if statement.strip():
                db.execute(statement)
        db.execute('INSERT INTO corpus_migrations VALUES (1,?,?)', ('player-identities-v1', int(time.time()*1000)))
    if not db.execute('SELECT 1 FROM corpus_migrations WHERE revision=2').fetchone():
        for statement in Path(__file__).with_name('jobs.sql').read_text().split(';'):
            if statement.strip():
                db.execute(statement)
        db.execute('INSERT INTO corpus_migrations VALUES (2,?,?)', ('analysis-jobs-v1', int(time.time()*1000)))
    if not db.execute('SELECT 1 FROM corpus_migrations WHERE revision=3').fetchone():
        statements = Path(__file__).with_name('chronology.sql').read_text().split(';')
        columns = {row[1] for row in db.execute('PRAGMA table_info(replays)')}
        for index, statement in enumerate(statements):
            if statement.strip() and (index != 0 or 'played_at_unix_s' not in columns):
                db.execute(statement)
        db.execute('INSERT INTO corpus_migrations VALUES (3,?,?)', ('replay-played-at-v1', int(time.time()*1000)))


def migrate(db):
    db.execute('BEGIN IMMEDIATE')
    try:
        migrate_in_transaction(db)
        db.commit()
    except BaseException:
        db.rollback()
        raise
