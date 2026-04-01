import os
import sys
import json
import tarfile
import ijson
from pathlib import Path

def process_data(input_dir, output_dir):
    input_path = Path(input_dir)
    output_path = Path(output_dir)
    data_output_path = output_path / "data"
    data_output_path.mkdir(parents=True, exist_ok=True)
    
    parsed_count = 0

    # 1. Handle Raw JSON files (Current Situation)
    json_files = list(input_path.glob("*.json"))
    for json_file in json_files:
        print(f"Parsing raw JSON: {json_file.name}...")
        with open(json_file, 'r') as f:
            parsed_count += parse_and_split(f, data_output_path)

    # 2. Handle Tarballs (For backwards compatibility)
    tar_files = list(input_path.glob("*.tar.gz"))
    for tar_file in tar_files:
        print(f"Extracting and parsing tarball: {tar_file.name}...")
        try:
            with tarfile.open(tar_file, "r:gz") as tar:
                for member in tar.getmembers():
                    if member.name.endswith(".json"):
                        f = tar.extractfile(member)
                        if f:
                            parsed_count += parse_and_split(f, data_output_path)
        except Exception as e:
            print(f"!! Failed to process {tar_file.name}: {e}")

    if parsed_count == 0:
        print(f"!! ERROR: No reports were parsed from {input_dir}. Found {len(json_files)} JSONs and {len(tar_files)} tarballs.")
        sys.exit(1)
    
    print(f"Done! Processed {parsed_count} total reports.")

def parse_and_split(file_handle, data_output_path):
    count = 0
    # Use ijson to handle the root array format you shared earlier
    parser = ijson.items(file_handle, 'item')
    
    for report in parser:
        app_id = report.get("appId")
        if not app_id:
            continue
            
        app_file = data_output_path / f"{app_id}.json"
        
        # Load existing if present to append
        existing = []
        if app_file.exists():
            with open(app_file, "r") as af:
                try:
                    existing = json.load(af)
                except:
                    existing = []
        
        existing.append(report)
        with open(app_file, "w") as af:
            json.dump(existing, af, indent=2)
        count += 1
    return count

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 split_reports.py <input_dir> <output_dir>")
        sys.exit(1)
    process_data(sys.argv[1], sys.argv[2])
