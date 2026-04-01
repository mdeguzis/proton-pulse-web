#!/usr/bin/env python3
import gzip
import ijson
import json
import os
import sys
import argparse
from collections import defaultdict

def flush_buffer(buffer, data_dir):
    """Writes buffered reports to individual appId.json files."""
    for app_id, reports in buffer.items():
        file_path = os.path.join(data_dir, f"{app_id}.json")
        
        existing_data = []
        if os.path.exists(file_path):
            with open(file_path, "r") as f:
                try:
                    existing_data = json.load(f)
                except json.JSONDecodeError:
                    existing_data = []
        
        existing_data.extend(reports)
        
        with open(file_path, "w") as f:
            # Minify JSON for faster Steam Deck downloads
            json.dump(existing_data, f, separators=(",", ":"))

def process_dump(dump_path, output_dir):
    """Streams the 2GB+ dump and splits it without crashing RAM."""
    print(f"Opening dump: {dump_path}")
    data_dir = os.path.join(output_dir, "data")
    os.makedirs(data_dir, exist_ok=True)

    buffer = defaultdict(list)
    report_count = 0
    unique_apps = set()

    try:
        with gzip.open(dump_path, "rb") as f:
            # Use ijson to stream the array items one-by-one
            parser = ijson.items(f, "item")
            
            for report in parser:
                app_id = report.get("app", {}).get("appId")
                if not app_id:
                    continue

                # Strip unnecessary bloat to keep files tiny
                simplified = {
                    "appId": app_id,
                    "verdict": report.get("responses", {}).get("verdict"),
                    "protonVersion": report.get("responses", {}).get("protonVersion"),
                    "gpu": report.get("systemInfo", {}).get("gpu"),
                    "timestamp": report.get("timestamp")
                }

                buffer[app_id].append(simplified)
                unique_apps.add(app_id)
                report_count += 1

                # Flush every 15k reports to keep memory usage low
                if report_count % 15000 == 0:
                    print(f"Processed {report_count} reports...")
                    flush_buffer(buffer, data_dir)
                    buffer.clear()

        flush_buffer(buffer, data_dir)
        
        # Final status index
        with open(os.path.join(output_dir, "index.json"), "w") as f:
            json.dump({
                "total_reports": report_count,
                "total_games": len(unique_apps)
            }, f, indent=2)

        print(f"\nDone! Processed {report_count} reports for {len(unique_apps)} games.")

    except Exception as e:
        print(f"Error processing dump: {e}")
        sys.exit(1)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("dump")
    parser.add_argument("output_dir")
    args = parser.parse_args()
    process_dump(args.dump, args.output_dir)

if __name__ == "__main__":
    main()
