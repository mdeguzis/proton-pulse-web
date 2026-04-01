import os
import sys
import json
import tarfile
import ijson
from pathlib import Path

def process_tarballs(input_dir, output_dir):
    input_path = Path(input_dir)
    output_path = Path(output_dir)
    data_output_path = output_path / "data"
    
    # Ensure output directories exist
    data_output_path.mkdir(parents=True, exist_ok=True)
    
    parsed_count = 0
    tar_files = sorted(list(input_path.glob("*.tar.gz")))
    
    if not tar_files:
        print(f"!! ERROR: No .tar.gz files found in {input_dir}")
        sys.exit(1)

    for i, tar_file in enumerate(tar_files, 1):
        print(f"[{i}/{len(tar_files)}] Extracting and parsing: {tar_file.name}...")
        
        try:
            with tarfile.open(tar_file, "r:gz") as tar:
                for member in tar.getmembers():
                    if member.name.endswith(".json"):
                        f = tar.extractfile(member)
                        if f is None:
                            continue
                            
                        # Use ijson to parse the root-level array items
                        # 'item' targets each object inside the [ ... ]
                        parser = ijson.items(f, 'item')
                        
                        for report in parser:
                            app_id = report.get("appId")
                            if not app_id:
                                continue
                                
                            # Define path for this specific AppID
                            app_file = data_output_path / f"{app_id}.json"
                            
                            # Append or create the report list for this app
                            existing_reports = []
                            if app_file.exists():
                                with open(app_file, "r") as af:
                                    try:
                                        existing_reports = json.load(af)
                                    except json.JSONDecodeError:
                                        existing_reports = []
                            
                            existing_reports.append(report)
                            
                            with open(app_file, "w") as af:
                                json.dump(existing_reports, af, indent=2)
                            
                            parsed_count += 1
        except Exception as e:
            print(f"!! Failed to process {tar_file.name}: {e}")

    if parsed_count == 0:
        print("!! WARNING: No reports were parsed. Check JSON structure.")
        sys.exit(1)
    else:
        print(f"Successfully processed {parsed_count} reports into {data_output_path}")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 split_reports.py <input_dir> <output_dir>")
        sys.exit(1)
        
    process_tarballs(sys.argv[1], sys.argv[2])
