#!/usr/bin/env python3
import json
import os
import sys
import argparse
from collections import defaultdict

def process_reports(input_dir, output_dir):
    print(f"Reading from official-data: {input_dir}")
    data_dir = os.path.join(output_dir, "data")
    os.makedirs(data_dir, exist_ok=True)

    report_count = 0
    game_count = 0

    # The bdefore/protondb-data repo stores files in reports/ (A-Z/0-9 subdirs)
    for root, _, files in os.walk(input_dir):
        for file in files:
            if not file.endswith(".json"):
                continue
                
            file_path = os.path.join(root, file)
            try:
                with open(file_path, "r") as f:
                    report = json.load(f)
                
                # Extract app_id from filename or JSON
                app_id = report.get("app", {}).get("appId")
                if not app_id:
                    # Fallback to filename if JSON is missing appId
                    app_id = file.split(".")[0]

                # Prepare optimized format for SteamedMango
                simplified = {
                    "v": report.get("responses", {}).get("verdict"),
                    "p": report.get("responses", {}).get("protonVersion"),
                    "ts": report.get("timestamp")
                }

                target_file = os.path.join(data_dir, f"{app_id}.json")
                
                # Load existing or start new list
                game_reports = []
                if os.path.exists(target_file):
                    with open(target_file, "r") as tf:
                        game_reports = json.load(tf)
                
                game_reports.append(simplified)
                
                # Deduplicate & Sort
                seen = set()
                unique = []
                for r in game_reports:
                    key = f"{r.get('ts')}-{r.get('v')}"
                    if key not in seen:
                        unique.append(r)
                        seen.add(key)
                
                unique.sort(key=lambda x: x.get('ts', 0), reverse=True)

                with open(target_file, "w") as tf:
                    json.dump(unique, tf, separators=(",", ":"))
                
                report_count += 1
                if report_count % 5000 == 0:
                    print(f"Processed {report_count} reports...")

            except Exception as e:
                print(f"Skipping {file}: {e}")

    # Create summary status
    with open(os.path.join(output_dir, "status.json"), "w") as f:
        json.dump({"total_reports": report_count, "last_sync": "2026-04-01"}, f, indent=2)
    
    print(f"Complete! Processed {report_count} reports.")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input_dir")
    parser.add_argument("output_dir")
    args = parser.parse_args()
    process_reports(args.input_dir, args.output_dir)

if __name__ == "__main__":
    main()
