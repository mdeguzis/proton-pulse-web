import os
import json
import ijson
import sys
import tarfile
import io
from datetime import datetime
from collections import defaultdict

def process_reports(input_path, output_dir):
    abs_input = os.path.abspath(input_path)
    print(f"--> Scanning path: {abs_input}")
    
    if not os.path.exists(abs_input):
        print(f"!! ERROR: Path does not exist: {abs_input}")
        return

    # Check for the reports subfolder
    search_path = os.path.join(abs_input, 'reports') if os.path.isdir(os.path.join(abs_input, 'reports')) else abs_input
    
    game_reports = defaultdict(list)
    total_reports = 0
    
    # Iterate through the .tar.gz files found in the repo
    for root, _, files in os.walk(search_path):
        for file in files:
            if file.endswith('.tar.gz'):
                file_path = os.path.join(root, file)
                print(f"--> Extracting and processing: {file}")
                
                try:
                    with tarfile.open(file_path, "r:gz") as tar:
                        for member in tar.getmembers():
                            if member.name.endswith('.json'):
                                # Extract file object
                                f = tar.extractfile(member)
                                if f:
                                    # Use the filename (appID) as the key
                                    app_id = os.path.splitext(os.path.basename(member.name))[0]
                                    
                                    # Use ijson to parse the stream
                                    try:
                                        parser = ijson.items(f, 'item')
                                        for report in parser:
                                            simplified = {
                                                "v": report.get("verdict"),
                                                "p": report.get("protonVersion"),
                                                "t": report.get("timestamp")
                                            }
                                            game_reports[app_id].append(simplified)
                                            total_reports += 1
                                    except Exception as parse_err:
                                        print(f"    ! Error parsing {member.name}: {parse_err}")
                except Exception as e:
                    print(f"!! Failed to open tarball {file}: {e}")

    # Create output directories
    data_dir = os.path.join(output_dir, 'data')
    os.makedirs(data_dir, exist_ok=True)

    # Write per-game JSON files
    for app_id, reports in game_reports.items():
        reports.sort(key=lambda x: x.get('t', 0) if x.get('t') else 0, reverse=True)
        with open(os.path.join(data_dir, f"{app_id}.json"), 'w') as f:
            json.dump(reports, f)

    # Create manifest
    manifest = {
        "last_updated": datetime.now(datetime.UTC).isoformat(),
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
