from pathlib import Path
import sys


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from pipeline.cli import main  # noqa: E402
from pipeline.backfill import backfill_missing_apps, compute_live_report_hash, load_backfill_app_ids  # noqa: E402
from pipeline.finalize import generate_app_indexes, generate_index_html  # noqa: E402
from pipeline.process import parse_and_split, process_reports  # noqa: E402
from pipeline.state import (  # noqa: E402
    PIPELINE_STATE_FILENAME,
    deserialize_index_keys,
    pipeline_state_path,
    read_pipeline_state,
    serialize_index_keys,
    write_pipeline_state,
)


if __name__ == "__main__":
    main()
