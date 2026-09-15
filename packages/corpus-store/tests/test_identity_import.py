import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

PYTHON = Path(__file__).resolve().parents[1]/'python'
sys.path.insert(0, str(PYTHON))

from identities import apply_catalog, export_catalog
from identity_import import administer, atomic_write
import store


class IdentityImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.base_path = self.root/'identities.json'
        self.output_path = self.root/'identities-next.json'
        self.base = {'schema_version': 'bw-forge-identities-v1', 'players': [
            {'key': 'flash', 'display_name': 'Flash', 'aliases': []},
            {'key': 'jaedong', 'display_name': 'Jaedong', 'aliases': []}],
            'overrides': [], 'groups': [{'key': 'legends', 'display_name': 'Legends', 'players': ['flash', 'jaedong']}],
            'scopes': [{'key': 'featured', 'display_name': 'Featured',
                        'self': {'players': [], 'groups': ['legends']},
                        'opponent': {'players': [], 'groups': []}, 'filters': {}, 'replay_sha256': []}]}
        self.base_path.write_text(json.dumps(self.base), encoding='utf8')

    def tearDown(self):
        self.tmp.cleanup()

    def write_csv(self, rows):
        path = self.root/'aliases.csv'
        path.write_text('player_key,display_name,namespace,alias\n' + '\n'.join(','.join(row) for row in rows) + '\n', encoding='utf8')
        return path

    def test_csv_dry_run_and_write_preserve_complete_catalog(self):
        source = self.write_csv([
            ('jaedong', 'Jaedong', 'legacy-unknown', 'July'),
            ('jaedong', 'Jaedong', 'legacy-unknown', 'n.Die_Jaedong'),
            ('jaedong', 'Jaedong', 'legacy-unknown', 'JD'),
            ('flash', 'Flash', 'legacy-unknown', 'By.FlaSh')])
        before = self.base_path.read_bytes()
        dry = administer(source, self.base_path, self.output_path, 'csv', True)
        self.assertEqual((dry['status'], dry['aliasesAdded'], dry['conflicts'], dry['outputWouldChange']), ('dry-run', 4, 0, True))
        self.assertFalse(self.output_path.exists())
        self.assertEqual(self.base_path.read_bytes(), before)
        written = administer(source, self.base_path, self.output_path, 'csv')
        self.assertEqual(written['status'], 'written')
        merged = json.loads(self.output_path.read_text(encoding='utf8'))
        self.assertEqual(merged['groups'], self.base['groups'])
        self.assertEqual(merged['scopes'], self.base['scopes'])
        self.assertEqual([alias['name'] for player in merged['players'] for alias in player['aliases']], ['By.FlaSh', 'JD', 'July', 'n.Die_Jaedong'])
        first_bytes = self.output_path.read_bytes()
        self.assertEqual(administer(source, self.base_path, self.output_path, 'csv')['status'], 'no-op')
        self.assertEqual(self.output_path.read_bytes(), first_bytes)

    def test_json_rows_duplicate_and_casefold_deterministically(self):
        source = self.root/'aliases.json'
        source.write_text(json.dumps({'aliases': [
            {'player_key': 'jaedong', 'namespace': 'ladder', 'alias': 'Straße'},
            {'player_key': 'jaedong', 'namespace': 'ladder', 'alias': 'STRASSE'},
            {'player_key': 'jaedong', 'namespace': 'ladder', 'alias': 'Straße'}]}), encoding='utf8')
        first = administer(source, self.base_path, self.output_path, 'json')
        self.assertEqual((first['aliasesAdded'], first['aliasesUnchanged'], first['conflicts']), (1, 0, 0))
        aliases = json.loads(self.output_path.read_text(encoding='utf8'))['players'][1]['aliases']
        self.assertEqual(aliases, [{'namespace': 'ladder', 'name': 'STRASSE'}])

    def test_conflicts_are_structured_and_never_write(self):
        self.base['players'][0]['aliases'] = [{'namespace': 'legacy-unknown', 'name': 'Shared'}]
        self.base_path.write_text(json.dumps(self.base), encoding='utf8')
        source = self.write_csv([
            ('missing', 'Missing', 'legacy-unknown', 'Unknown'),
            ('jaedong', 'Wrong Name', 'legacy-unknown', 'Mismatch'),
            ('jaedong', 'Jaedong', 'legacy-unknown', 'SHARED')])
        result = administer(source, self.base_path, self.output_path, 'csv', True)
        self.assertEqual(result['status'], 'dry-run')
        self.assertEqual(result['conflicts'], 3)
        self.assertEqual({conflict['type'] for conflict in result['conflictDetails']},
                         {'unknown_player', 'display_name_mismatch', 'alias_collision'})
        result = administer(source, self.base_path, self.output_path, 'csv')
        self.assertEqual(result['status'], 'conflict')
        self.assertFalse(self.output_path.exists())

    def test_different_import_targets_for_same_casefold_are_a_conflict(self):
        source = self.write_csv([
            ('flash', 'Flash', 'one', 'Foo'),
            ('jaedong', 'Jaedong', 'one', 'FOO')])
        result = administer(source, self.base_path, self.output_path, 'csv', True)
        self.assertEqual(result['aliasesAdded'], 0)
        self.assertEqual(result['conflictDetails'][0]['type'], 'input_alias_collision')

    def test_atomic_failure_preserves_previous_file_and_cleans_temporary(self):
        previous = b'previous\n'
        self.output_path.write_bytes(previous)
        def reject(_temporary, _target):
            raise RuntimeError('injected failure')
        with self.assertRaisesRegex(RuntimeError, 'injected failure'):
            atomic_write(self.output_path, b'next\n', reject)
        self.assertEqual(self.output_path.read_bytes(), previous)
        self.assertEqual(list(self.root.glob('.identities-next.json.*.tmp')), [])

    def test_generated_output_applies_and_round_trips_without_schema_or_evidence_changes(self):
        source = self.write_csv([('jaedong', 'Jaedong', 'legacy-unknown', 'July')])
        administer(source, self.base_path, self.output_path, 'csv')
        database = self.root/'corpus.sqlite'
        with closing(sqlite3.connect(database)) as db:
            store.initialize(db)
            evidence = list(db.execute('SELECT * FROM corpus_metadata'))
            self.assertEqual(apply_catalog(db, json.loads(self.output_path.read_text(encoding='utf8')))['status'], 'applied')
            exported = export_catalog(db)
            self.assertEqual(apply_catalog(db, exported)['status'], 'no-op')
            self.assertEqual(list(db.execute('SELECT * FROM corpus_metadata')), evidence)
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 2)


if __name__ == '__main__':
    unittest.main()
