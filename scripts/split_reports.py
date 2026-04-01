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
    os.makedirs(data_dir, exist_ok=True)

    # 1. Load the manifest to see what we've already processed
    processed_files = []
    if os.path.exists(manifest_path):
        try:
            with open(manifest_path, 'r') as f:
                m_data = json.load(f)
                processed_files = m_data.get("processed_files", [])
                print(f"--> Found manifest. {len(processed_files)} archives already handled.", flush=True)
        except Exception as e:
            print(f"--> Manifest corrupt or missing, starting fresh: {e}", flush=True)

    # 2. Identify new archives
    search_path = os.path.join(abs_input, 'reports') if os.path.isdir(os.path.join(abs_input, 'reports')) else abs_input
    try:
        all_tarballs = sorted([f for f in os.listdir(search_path) if f.endswith('.tar.gz')])
        new_tarballs = [f for f in all_tarballs if f not in processed_files]
    except FileNotFoundError:
        print(f"!! ERROR: Path not found: {search_path}", flush=True)
        return

    if not new_tarballs:
        print("--> Everything is up to date. No new archives to process.", flush=True)
        return

    print(f"--> {len(new_tarballs)} new archives found (Total archives in repo: {len(all_tarballs)})", flush=True)

    # 3. Process only the NEW archives
    game_updates = defaultdict(list)
    new_report_count = 0

    for index, file in enumerate(new_tarballs, 1):
        file_path = os.path.join(search_path, file)
        print(f"[{index}/{len(new_tarballs)}] Processing: {file}...", flush=True)
        
        file_report_count = 0
        try:
            with tarfile.open(file_path, "r:gz") as tar:
                for member in tar.getmembers():
                    if member.name.endswith('.json'):
                        f = tar.extractfile(member)
                        if f:
                            app_id = os.path.splitext(os.path.basename(member.name))[0]
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
                                    file_report_count += 1
                            except Exception:
                                continue
            print(f"    Done. ({file_report_count} reports found)", flush=True)
        except Exception as e:
            print(f"!! Error opening {file}: {e}", flush=True)

    # 4. Merge and Write
    print(f"--> Merging updates for {len(game_updates)} games...", flush=True)
    for app_id, new_reports in game_updates.items():
        target_file = os.path.join(data_dir, f"{app_id}.json")
        
        existing_data = []
        if os.path.exists(target_file):
            with open(target_file, 'r') as f:
                try:
                    existing_data = json.load(f)
                except:
                    existing_data = []

        # Combine, sort by date descending, and write
        combined = existing_data + new_reports
        combined.sort(key=lambda x: str(x.get('t', '')), reverse=True)
        
        with open(target_file, 'w') as f:
            json.dump(combined, f)

    # 5. Save updated manifest
    final_manifest = {
        "last_updated": datetime.now().isoformat(),
        "processed_files": all_tarballs,
        "total_new_reports_this_run": new_report_count
    }
    with open(manifest_path, 'w') as f:
        json.dump(final_manifest, f, indent=2)

    print(f"--- FINISH ---", flush=True)
    print(f"Added {new_report_count} reports to the database.", flush=True)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 split_reports.py <input_dir> <output_dir>")
        sys.exit(1)
    process_reports(sys.argv[1], sys.argv[2])
