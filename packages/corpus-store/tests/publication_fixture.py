"""Create the same source oracle used by store tests for TypeScript publication tests."""
import importlib.util
import shutil
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('test_store', Path(__file__).with_name('test_store.py'))
tests = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tests)
fixture = tests.StoreTests()
fixture.setUp()
try:
    shutil.copytree(fixture.artifacts, Path(sys.argv[1]))
finally:
    fixture.tearDown()
