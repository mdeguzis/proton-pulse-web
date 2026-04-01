import os
import json
import ijson
import sys
import tarfile
from datetime import datetime
from collections import defaultdict

def process_reports(input_path, output_dir):
    abs_input = os.path.abspath(input_path)
    data_dir = os.path.join(output_dir, 'data')
    manifest_path = os.path.join(output_dir, 'manifest.json')
    
    # Ensure the data directory exists before we do anything
    os.makedirs(data_dir, exist_ok=True)

    processed_files = []
    if os.path.exists(manifest_path):
        try:
            with open(manifest_path, 'r') as f:
                m_data = json.load(f)
                processed_files = m_data.get("processed_files", [])
        except:
            pass

    # ProtonDB data repo has a 'reports' subfolder
    search_path = os.path.join(abs_input, 'reports') if os.path.isdir(os.path.join(abs_input, 'reports')) else abs_input
    
    try:
        all_tarballs = sorted([f for f in os.listdir(search_path) if f.endswith('.tar.gz')])
        new_tarballs = [f for f in all_tarballs if f not in processed_files]
    except FileNotFoundError:
        print(f"!! Error: Could not find archives in {search_path}")
        return

    if not new_tarballs:
        print("--> No new data to process.")
        return

    game_updates = defaultdict(list)
    new_report_count = 0

    for index, file in enumerate(new_tarballs, 1):
        file_path = os.path.join(search_path, file)
        print(f"[{index}/{len(new_tarballs)}] Extracting: {file}...", flush=True)
        
        try:
            with tarfile.open(file_path, "r:gz") as tar:
                for member in tar.getmembers():
                    if member.name.endswith('.json'):
                        # Extract AppID from filename (e.g., 'reports/12345.json' -> '12345')
                        app_id = os.path.basename(member.name).replace('.json', '')
                        
                        if not app_id.isdigit():
                            continue

                        f = tar.extractfile(member)
                        if f:
                            try:
                                # Use item='' to match any object in a root-level list
                                # If the JSON is a list of objects, ijson.items(f, 'item') works
                                # for some versions, but '' is the most robust for root lists.
                                parser = ijson.items(f, 'item')
                                found_in_file = 0
                                for report in parser:
                                    simplified = {
                                        "v": report.get("verdict"),
                                        "p": report.get("protonVersion"),
                                        "t": report.get("timestamp")
                                    }
                                    game_updates[app_id].append(simplified)
                                    new_report_count += 1
                                    found_in_file += 1
                                
                                # Fallback: if 'item' found nothing, try the root
                                if found_in_file == 0:
                                    f.seek(0)
                                    parser = ijson.items(f, '')
                                    for report in parser:
                                        if isinstance(report, dict):
                                            simplified = {
                                                "v": report.get("verdict"),
                                                "p": report.get("protonVersion"),
                                                "t": report.get("timestamp")
                                            }
                                            game_updates[app_id].append(simplified)
                                            new_report_count += 1
                            except Exception as e:
                                continue
        except Exception as e:
            print(f"!! Error processing {file}: {e}")

    if new_report_count == 0:
        print("!! WARNING: No reports were parsed. Check JSON structure.")
        return

    print(f"--> Merging and saving {len(game_updates)} games...", flush=True)
    for app_id, new_reports in game_updates.items():
        target_file = os.path.join(data_dir, f"{app_id}.json")
        
        existing_data = []
        if os.path.exists(target_file):
            with open(target_file, 'r') as f:
                try: existing_data = json.load(f)
                except: pass

        combined = existing_data + new_reports
        # Sort by timestamp (newest first)
        combined.sort(key=lambda x: str(x.get('t', '')), reverse=True)
        
        # Keep file size manageable for GitHub
        if len(combined) > 3000:
            combined = combined[:3000]
        
        with open(target_file, 'w') as f:
            json.dump(combined, f, separators=(',', ':')) # Minify output

    # Save manifest
    with open(manifest_path, 'w') as f:
        json.dump({
            "last_updated": datetime.now().isoformat(),
            "processed_files": all_tarballs,
            "total_reports": new_report_count
        }, f, indent=2)

    print(f"--- FINISH: Processed {new_report_count} reports ---")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 split_reports.py <input_dir> <output_dir>")
        sys.exit(1)
    process_reports(sys.argv[1], sys.argv[2])
