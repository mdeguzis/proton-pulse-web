#!/usr/bin/env python3
import json
import os
import argparse
from collections import defaultdict

def process_reports(input_dir, output_dir):
    print(f"Scanning for reports in: {input_dir}")
    data_dir = os.path.join(output_dir, "data")
    os.makedirs(data_dir, exist_ok=True)

    report_count = 0
    apps_processed = set()
    buffer = defaultdict(list)

    # Walk through the nested structure of bdefore/protondb-data
    # This finds files in reports/0/, reports/1/, etc.
    for root, _, files in os.walk(input_dir):
        for file in files:
            if not file.endswith(".json"):
                continue
                
            file_path = os.path.join(root, file)
            try:
                with open(file_path, "r") as f:
                    report = json.load(f)
                
                # Extract the Steam App ID
                app_id = report.get("app", {}).get("appId")
                if not app_id:
                    continue

                # Simplify the schema for SteamedMango performance
                # v = verdict, p = proton version, ts = timestamp
                entry = {
                    "v": report.get("responses", {}).get("verdict"),
                    "p": report.get("responses", {}).get("protonVersion"),
                    "ts": report.get("timestamp")
                }

                app_id_str = str(app_id)
                buffer[app_id_str].append(entry)
                apps_processed.add(app_id_str)
                report_count += 1

                # Flush to disk every 10k reports to keep memory usage low
                if report_count % 10000 == 0:
                    flush_to_disk(buffer, data_dir)
                    buffer.clear()
                    print(f"Progress: {report_count} reports processed...")

            except Exception:
                # Silently skip if a single JSON file is malformed
                continue

    # Final flush for remaining data in buffer
    flush_to_disk(buffer, data_dir)
    
    # Generate the Health Check manifest for the landing page
    manifest = {
        "total_reports": report_count,
        "total_games": len(apps_processed)
    }
    
    manifest_path = os.path.join(output_dir, "manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f)

    print(f"Success! {report_count} reports across {len(apps_processed)} games.")
    print(f"Manifest written to: {manifest_path}")

def flush_to_disk(buffer, data_dir):
    """Merges new reports with existing JSON files on disk."""
    for app_id, new_reports in buffer.items():
        target_path = os.path.join(data_dir, f"{app_id}.json")
        existing = []
        
        if os.path.exists(target_path):
            with open(target_path, "r") as f:
                try:
                    existing = json.load(f)
                except:
                    existing = []
        
        # Combine and deduplicate based on timestamp and verdict
        combined = existing + new_reports
        unique = []
        seen = set()
        for r in combined:
            # Create a unique key for deduplication
            key = f"{r.get('ts')}-{r.get('v')}"
            if key not in seen:
                unique.append(r)
                seen.add(key)
        
        # Sort by timestamp (newest reports first)
        unique.sort(key=lambda x: x.get('ts', 0), reverse=True)
        
        with open(target_path, "w") as f:
            # Use compact separators to save space on GitHub Pages
            json.dump(unique, f, separators=(",", ":"))

def main():
    parser = argparse.ArgumentParser(description="Split ProtonDB reports into per-app JSON files.")
    parser.add_argument("input_dir", help="Directory containing official ProtonDB JSON reports")
    parser.add_argument("output_dir", help="Directory to output the 'data' folder and 'manifest.json'")
    args = parser.parse_args()
    
    process_reports(args.input_dir, args.output_dir)

if __name__ == "__main__":
    main()
