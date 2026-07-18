import sys
from pathlib import Path

# backend/api/auth.py imports its sibling modules (e.g. `from supabase_client
# import get_client`) as flat/top-level names, the same way backend/api/app.py
# makes them importable (see its `sys.path.append(...)` at the top). Mirror
# that here so `import auth` works the same way in tests as it does in the
# real app.
BACKEND_API_DIR = Path(__file__).resolve().parent.parent / "api"
if str(BACKEND_API_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_API_DIR))
