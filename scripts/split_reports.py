import os
import json
import ijson
import sys
import tarfile
from datetime import datetime
from collections import defaultdict

def process_reports(input_path, output_dir):
    abs_input = os.path.abspath(input_path)
    print(f"--> Starting scan: {abs_input}", flush=True)
    
    if not os.path.exists(abs_input):
        print(f"!! ERROR: Path does not exist: {abs_input}", flush=True)
        return

    # Check if we are looking at the root or the reports subdir
    search_path = os.path.join(abs_input, 'reports') if os.path.isdir(os.path.join(abs_input, 'reports')) else abs_input
    
    game_reports = defaultdict(list)
    total_reports = 0
    
    # Get a list of tarballs
    try:
        tarballs = sorted([f for f in os.listdir(search_path) if f.endswith('.tar.gz')])
    except FileNotFoundError:
        print(f"!! ERROR: Could not list directory: {search_path}", flush=True)
        return

    print(f"--> Found {len(tarballs)} archives to process.", flush=True)

    for file in tarballs:
        file_path = os.path.join(search_path, file)
        print(f"--> Processing {file}...", flush=True)
        
        file_count = 0
        try:
            with tarfile.open(file_path, "r:gz") as tar:
                for member in tar.getmembers():
                    if member.name.endswith('.json'):
                        f = tar.extractfile(member)
                        if f:
                            # AppID is usually the filename (e.g., 12345.json)
                            app_id = os.path.splitext(os.path.basename(member.name))[0]
                            try:
                                # ijson.items helps process large JSON arrays without loading all into RAM
                                parser = ijson.items(f, 'item')
                                for report in parser:
                                    simplified = {
                                        "v": report.get("verdict"),
                                        "p": report.get("protonVersion"),
                                        "t": report.get("timestamp")
                                    }
                                    game_reports[app_id].append(simplified)
                                    total_reports += 1
                                    file_count += 1
                            except Exception:
                                # Skip malformed individual JSON files within the tar
                                continue
            print(f"    Done. ({file_count} reports extracted)", flush=True)
        except Exception as e:
            print(f"!! Failed to open {file}: {e}", flush=True)

    print(f"--> Writing output files to {output_dir}...", flush=True)
    data_dir = os.path.join(output_dir, 'data')
    os.makedirs(data_dir, exist_ok=True)

    for app_id, reports in game_reports.items():
        # FIX: Force timestamp 't' to string to avoid TypeError: '<' between str and int
        # This sorts by date/time descending
        reports.sort(key=lambda x: str(x.get('t', '')), reverse=True)
        
        with open(os.path.join(data_dir, f"{app_id}.json"), 'w') as f:
            json.dump(reports, f)

    # Create a manifest for the frontend/hosting
    manifest = {
        "last_updated": datetime.now().isoformat(),
        "total_games": len(game_reports),
        "total_reports": total_reports
    }
    
    with open(os.path.join(output_dir, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=2)

    print(f"--- FINISH ---", flush=True)
    print(f"Processed {total_reports} reports for {len(game_reports)} games.", flush=True)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 split_reports.py <input_dir> <output_dir>")
        sys.exit(1)
    
    # Run the processor
    process_reports(sys.argv[1], sys.argv[2])
