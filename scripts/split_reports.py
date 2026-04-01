import os
import json
import ijson
import sys
from datetime import datetime
from collections import defaultdict

def process_reports(input_path, output_dir):
    # --- DIAGNOSTIC LOGGING ---
    abs_input = os.path.abspath(input_path)
    print(f"--> Scanning path: {abs_input}")
    
    if not os.path.exists(abs_input):
        print(f"!! ERROR: Path does not exist: {abs_input}")
        return

    # If user pointed to the root, try to find 'reports' subfolder automatically
    if os.path.isdir(os.path.join(abs_input, 'reports')):
        print("--> Found 'reports' subfolder, shifting search there.")
        search_path = os.path.join(abs_input, 'reports')
    else:
        search_path = abs_input

    print(f"--> Directory contents of {search_path}: {os.listdir(search_path)[:5]}...")
    # --------------------------

    game_reports = defaultdict(list)
    total_reports = 0
    
    for root, _, files in os.walk(search_path):
        for file in files:
            if file.endswith('.json'):
                file_path = os.path.join(root, file)
                try:
                    with open(file_path, 'r') as f:
                        app_id = os.path.splitext(file)[0]
                        # ijson for memory efficiency
                        parser = ijson.items(f, 'item')
                        for report in parser:
                            simplified = {
                                "v": report.get("verdict"),
                                "p": report.get("protonVersion"),
                                "t": report.get("timestamp")
                            }
                            game_reports[app_id].append(simplified)
                            total_reports += 1
                except Exception as e:
                    print(f"!! Warning: Failed to process {file_path}: {e}")

    # Ensure output directories exist
    data_dir = os.path.join(output_dir, 'data')
    os.makedirs(data_dir, exist_ok=True)

    # Write per-game JSON files
    for app_id, reports in game_reports.items():
        reports.sort(key=lambda x: x.get('t', ''), reverse=True)
        with open(os.path.join(data_dir, f"{app_id}.json"), 'w') as f:
            json.dump(reports, f)

    # Create health-check manifest
    manifest = {
        "last_updated": datetime.utcnow().isoformat(),
        "total_games": len(game_reports),
        "total_reports": total_reports
    }
    
    with open(os.path.join(output_dir, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=2)

    print(f"Success! {total_reports} reports across {len(game_reports)} games.")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 split_reports.py <input_dir> <output_dir>")
        sys.exit(1)
    process_reports(sys.argv[1], sys.argv[2])
