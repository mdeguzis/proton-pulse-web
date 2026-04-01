import logging
import json
import ijson
import sys
import tarfile
import os
from datetime import datetime
from collections import defaultdict

# Configure professional logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('split_reports.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

# Constants
MAX_REPORTS_PER_FILE = 5000

def process_reports(input_path, output_dir):
    abs_input = os.path.abspath(input_path)
    data_dir = os.path.join(output_dir, 'data')
    manifest_path = os.path.join(output_dir, 'manifest.json')
    os.makedirs(data_dir, exist_ok=True)

    logger.info(f"Starting scan: {abs_input}")

    processed_files = []
    if os.path.exists(manifest_path):
        try:
            with open(manifest_path, 'r') as f:
                m_data = json.load(f)
                processed_files = m_data.get("processed_files", [])
                logger.info(f"Found manifest. {len(processed_files)} archives already processed.")
        except Exception as e:
            logger.warning(f"Manifest error, starting fresh: {e}")

    search_path = os.path.join(abs_input, 'reports') if os.path.isdir(os.path.join(abs_input, 'reports')) else abs_input
    try:
        all_tarballs = sorted([f for f in os.listdir(search_path) if f.endswith('.tar.gz')])
        new_tarballs = [f for f in all_tarballs if f not in processed_files]
    except FileNotFoundError:
        logger.error(f"Path not found: {search_path}")
        return

    if not new_tarballs:
        logger.info("No new data to process.")
        return

    logger.info(f"Found {len(new_tarballs)} new archives (total: {len(all_tarballs)})")

    game_updates = defaultdict(list)
    new_report_count = 0

    for index, file in enumerate(new_tarballs, 1):
        file_path = os.path.join(search_path, file)
        logger.info(f"[{index}/{len(new_tarballs)}] Extracting: {file}")
        
        try:
            with tarfile.open(file_path, "r:gz") as tar:
                for member in tar.getmembers():
                    if member.name.endswith('.json'):
                        filename = os.path.basename(member.name)
                        app_id = filename.replace('.json', '')
                        
                        if not app_id.isdigit():
                            continue

                        f = tar.extractfile(member)
                        if f:
                            try:
                                parser = ijson.items(f, 'item')
                                for report in parser:
                                    simplified = {
                                        "v": report.get("verdict"),
                                        "p": report.get("protonVersion"),
                                        "t": report.get("timestamp")
                                    }
                                    game_updates[app_id].append(simplified)
                                    new_report_count += 1
                            except Exception as e:
                                logger.debug(f"Error parsing report: {e}")
                                continue
            logger.info(f"Completed extracting {file}")
        except Exception as e:
            logger.error(f"Error opening {file}: {e}")

    logger.info(f"Merging and cleaning data for {len(game_updates)} games")
    
    for app_id, new_reports in game_updates.items():
        target_file = os.path.join(data_dir, f"{app_id}.json")
        
        existing_data = []
        if os.path.exists(target_file):
            with open(target_file, 'r') as f:
                try:
                    existing_data = json.load(f)
                except Exception as e:
                    logger.warning(f"Could not load {target_file}: {e}")

        combined = existing_data + new_reports
        combined.sort(key=lambda x: str(x.get('t', '')), reverse=True)
        
        # File size protection: cap at MAX_REPORTS_PER_FILE to avoid GitHub limits
        if len(combined) > MAX_REPORTS_PER_FILE:
            logger.warning(f"App {app_id} has {len(combined)} reports, capping at {MAX_REPORTS_PER_FILE}")
            combined = combined[:MAX_REPORTS_PER_FILE]
        
        with open(target_file, 'w') as f:
            json.dump(combined, f)
        
        logger.debug(f"Wrote {len(combined)} reports for app {app_id}")

    # Save manifest
    with open(manifest_path, 'w') as f:
        json.dump({
            "last_updated": datetime.now().isoformat(),
            "processed_files": all_tarballs,
            "total_games": len(next(os.walk(data_dir))[2]),
            "total_new_reports": new_report_count,
            "max_reports_per_file": MAX_REPORTS_PER_FILE
        }, f, indent=2)

    logger.info(f"Finished: Processed {new_report_count} new reports")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 split_reports.py <input_dir> <output_dir>")
        sys.exit(1)
    process_reports(sys.argv[1], sys.argv[2])