"""Regenerate the query mapping from Python's python-casefold-v1 normalizer."""
import json
import sys
import unicodedata
from pathlib import Path

mapping = {chr(i): chr(i).casefold() for i in range(sys.maxunicode + 1) if chr(i) != chr(i).casefold()}
target = Path(__file__).resolve().parents[1] / 'src/identity/casefold.ts'
target.write_text(
    '// Python str.casefold mapping, Unicode ' + unicodedata.unidata_version + '. Generated; no locale or compatibility normalization.\n'
    + 'const mapping: Record<string,string> = ' + json.dumps(mapping, ensure_ascii=True, separators=(',', ':')) + ';\n'
    + 'export function normalizeName(value: string): string { return Array.from(value, c => mapping[c] ?? c).join(""); }\n',
    encoding='utf8')
