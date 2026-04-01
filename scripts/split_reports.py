import os
import sys
import tarfile
import json
import logging
from collections import defaultdict

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
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def process_tar_gz(file_path):
    """Process a tar.gz file and extract reports grouped by appId"""
    app_reports = defaultdict(list)
    
    try:
        with tarfile.open(file_path, 'r:gz') as tar:
            for member in tar.getmembers():
                if member.isfile() and member.name.endswith('.json'):
                    try:
                        file_obj = tar.extractfile(member)
                        data = json.load(file_obj)
                        
                        # Handle both single report and array of reports
                        reports = data if isinstance(data, list) else [data]
                        
                        for report in reports:
                            appId = report.get('appId')
                            if appId:
                                report_data = {
                                    'v': report.get('rating'),
                                    'p': report.get('protonVersion'),
                                    't': report.get('timestamp'),
                                }
                                app_reports[appId].append(report_data)
                                logger.info(f'Processed report for appId {appId}')
                    except Exception as e:
                        logger.error(f'Error processing {member.name}: {e}')
    except Exception as e:
        logger.error(f'Error processing tar file {file_path}: {e}')
    
    return app_reports

def save_reports(app_reports):
    """Save aggregated reports by appId"""
    for appId, reports in app_reports.items():
        if reports:
            # Limit to MAX_REPORTS_PER_FILE
            limited_reports = reports[:MAX_REPORTS_PER_FILE]
            report_file_path = os.path.join(DATA_DIR, f'{appId}.json')
            
            try:
                with open(report_file_path, 'w') as report_file:
                    json.dump(limited_reports, report_file)
                logger.info(f'Generated report file: {report_file_path} with {len(limited_reports)} reports')
            except Exception as e:
                logger.error(f'Error writing {report_file_path}: {e}')

def process_directory(input_dir):
    """Process all tar.gz files in input directory"""
    all_app_reports = defaultdict(list)
    
    for root, dirs, files in os.walk(input_dir):
        for filename in files:
            if filename.endswith('.tar.gz'):
                file_path = os.path.join(root, filename)
                logger.info(f'Processing {file_path}')
                
                app_reports = process_tar_gz(file_path)
                
                # Merge reports by appId
                for appId, reports in app_reports.items():
                    all_app_reports[appId].extend(reports)
    
    return all_app_reports

if __name__ == '__main__':
    logger.info(f'Starting processing of {INPUT_DIR}')
    all_reports = process_directory(INPUT_DIR)
    
    if all_reports:
        save_reports(all_reports)
        logger.info('Processing completed successfully')
    else:
        logger.warning('No reports found to process')