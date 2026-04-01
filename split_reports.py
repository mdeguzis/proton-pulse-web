import os
import sys
import tarfile
import json
import logging
from datetime import datetime

# Constants
MAX_REPORTS_PER_FILE = 5000

# Check for command-line arguments
if len(sys.argv) != 3:
    print("Usage: python split_reports.py <input_directory> <output_directory>")
    sys.exit(1)

INPUT_DIR = sys.argv[1]
DATA_DIR = sys.argv[2]

# Ensure the input directory exists
if not os.path.exists(INPUT_DIR):
    print(f"Input directory '{INPUT_DIR}' does not exist.")
    sys.exit(1)

# Create output directory if it doesn't exist
if not os.path.exists(DATA_DIR):
    os.makedirs(DATA_DIR)

# Set up logging
logging.basicConfig(level=logging.INFO, filename='process.log', format='%(asctime)s - %(levelname)s - %(message)s')
console = logging.StreamHandler()
console.setLevel(logging.INFO)
logging.getLogger().addHandler(console)

def process_tar_gz(file_path):
    reports = []
    with tarfile.open(file_path, 'r:gz') as tar:
        for index, member in enumerate(tar.getmembers()):
            if member.isfile():
                file = tar.extractfile(member)
                data = json.load(file)  # Assuming each file contains a JSON array of reports
                for report in data:
                    if len(reports) < MAX_REPORTS_PER_FILE:
                        appId = report.get('appId')
                        rating = report.get('rating')
                        protonVersion = report.get('protonVersion')
                        timestamp = report.get('timestamp')
                        report_data = {
                            'v': rating,  # Mapping rating to v
                            'p': protonVersion,  # Mapping protonVersion to p
                            't': timestamp,  # Mapping timestamp to t
                        }
                        reports.append(report_data)
                        logging.info(f'Processed report: {report_data}, Progress: [{index+1}/{len(data)}]')
                log_reports(appId, reports)
            else:
                logging.warning(f'Skipped non-JSON file: {member.name}')

def log_reports(appId, reports):
    report_file_path = os.path.join(DATA_DIR, f'{appId}.json')
    with open(report_file_path, 'w') as report_file:
        json.dump(reports, report_file)
    logging.info(f'Generated report file: {report_file_path}')

def process_reports(input_file):
    reports = []
    input_file_path = os.path.join(INPUT_DIR, input_file)
    
    if not os.path.exists(input_file_path):
        logging.error(f'Input file {input_file_path} not found.')
        return
    
    with open(input_file_path, 'r') as f:
        data = json.load(f)
        for report in data:
            appId = report.get('appId')
            rating = report.get('rating')
            protonVersion = report.get('protonVersion')
            timestamp = report.get('timestamp')
            report_data = {
                'v': rating,  # Mapping rating to v
                'p': protonVersion,  # Mapping protonVersion to p
                't': timestamp,  # Mapping timestamp to t
            }
            reports.append(report_data)
            logging.info(f'Processed report: {report_data}')
    log_reports(appId, reports)

if __name__ == '__main__':
    # Process all JSON files in the input directory
    if os.path.isdir(INPUT_DIR):
        for file_name in os.listdir(INPUT_DIR):
            if file_name.endswith('.json'):
                process_reports(file_name)
            elif file_name.endswith('.tar.gz'):
                tar_file_path = os.path.join(INPUT_DIR, file_name)
                process_tar_gz(tar_file_path)
    else:
        print(f"Input directory '{INPUT_DIR}' is not a valid directory.")
        sys.exit(1)