# Simple Upload Logging - How It Works

## Overview

**One Excel file per upload session** - Simple and effective!

## What You Get

Every time you upload videos, an **Excel file is automatically created** with complete details about what happened.

### Excel File Structure

**File Name**: `upload_2024-01-15_10-30-45.xlsx`

**Sheet 1: Summary**
```
Upload Session Report

Session ID:       upload_2024-01-15_10-30-45
Start Time:       1/15/2024, 10:30:45 AM
End Time:         1/15/2024, 10:35:23 AM
Total Files:      10

Results Summary:
Uploaded:         7
Skipped:          2
Failed:           1
```

**Sheet 2: Upload Details**

| File Name | Status | Video ID | Video Title | Duration | File Size | Reason/Error | Timestamp |
|-----------|--------|----------|-------------|----------|-----------|--------------|-----------|
| video1.mp4 | Uploaded | abc123xyz | Video 1 | 120 | 52.4 MB | | 10:30:15 AM |
| video2.mp4 | Skipped | def456uvw | Video 2 | 95 | 38.2 MB | Already uploaded | 10:30:18 AM |
| video3.mp4 | Uploaded | ghi789rst | Video 3 | 145 | 61.8 MB | | 10:31:22 AM |
| video4.mp4 | Failed | N/A | Video 4 | N/A | 48.5 MB | Network timeout | 10:32:15 AM |

## Where Are Logs Stored?

```
upload_logs/
├── upload_2024-01-15_10-30-45.xlsx
├── upload_2024-01-15_14-22-10.xlsx
└── upload_2024-01-16_09-15-33.xlsx
```

## Console Output

When you upload, you'll see real-time updates:

```
================================================================================
📊 Upload Session Started: upload_2024-01-15_10-30-45
   Total Files: 10
   Start Time: 1/15/2024, 10:30:45 AM
================================================================================

⊘ video2.mp4 (Already uploaded)
✅ video1.mp4 → Video ID: abc123xyz
✅ video3.mp4 → Video ID: ghi789rst
❌ video4.mp4 - Network timeout

================================================================================
🏁 Upload Session Completed: upload_2024-01-15_10-30-45
   Duration: 5m 23s
   ✅ Uploaded: 7
   ⊘ Skipped: 2
   ❌ Failed: 1
   📊 Log saved to: ./upload_logs/upload_2024-01-15_10-30-45.xlsx
================================================================================
```

## Status Types

| Status | Meaning | Icon |
|--------|---------|------|
| **Uploaded** | File successfully uploaded to VdoCipher | ✅ |
| **Skipped** | File already uploaded (duplicate detected) | ⊘ |
| **Failed** | Upload failed (error details in Reason column) | ❌ |

## How to Use

### 1. Upload Videos
Just use the web interface - logging happens automatically!

### 2. View Logs
Open the Excel file in the `upload_logs/` directory

### 3. Download Logs via API
```bash
# List all logs
curl http://localhost:4000/api/upload-logs

# Download specific log
curl -O http://localhost:4000/api/upload-logs/upload_2024-01-15_10-30-45.xlsx
```

## What Information Is Logged?

### For Every File:
- ✅ **File Name**: Original filename
- ✅ **Status**: Uploaded / Skipped / Failed
- ✅ **Video ID**: VdoCipher video identifier (if uploaded)
- ✅ **Video Title**: Title used in VdoCipher
- ✅ **Duration**: Video length in seconds
- ✅ **File Size**: Human-readable size (MB/GB)
- ✅ **Reason/Error**: Why skipped or error message if failed
- ✅ **Timestamp**: Exact time of the event

### For Each Session:
- ✅ **Session ID**: Unique identifier
- ✅ **Start/End Time**: When upload began and finished
- ✅ **Duration**: Total time taken
- ✅ **Counts**: Total uploaded, skipped, failed

## Use Cases

### Audit Trail
*"What videos were uploaded on January 15th?"*

→ Open `upload_2024-01-15_*.xlsx` files

### Troubleshooting
*"Why did video4.mp4 fail?"*

→ Check the "Reason/Error" column in Excel

### Reporting
*"How many videos uploaded successfully?"*

→ Check "Summary" sheet in Excel

### Verification
*"Was this video uploaded?"*

→ Search for filename in Excel file

## Advantages of This Simple Approach

✅ **Easy to Understand**: Just open Excel
✅ **No Learning Curve**: Everyone knows Excel
✅ **Portable**: Share files via email
✅ **Searchable**: Use Excel's find function
✅ **Filterable**: Sort by status, date, etc.
✅ **Editable**: Add your own notes
✅ **Archive-Friendly**: One file per upload session
✅ **No Database Required**: Just Excel files

## API Endpoints

### GET /api/upload-logs
Get list of all upload log files

**Response:**
```json
{
  "success": true,
  "count": 5,
  "logs": [
    {
      "fileName": "upload_2024-01-15_10-30-45.xlsx",
      "filePath": "./upload_logs/upload_2024-01-15_10-30-45.xlsx",
      "createdAt": "2024-01-15T10:35:23.000Z"
    }
  ]
}
```

### GET /api/upload-logs/:fileName
Download a specific log file

**Example:**
```bash
curl -O http://localhost:4000/api/upload-logs/upload_2024-01-15_10-30-45.xlsx
```

## Examples

### Check Upload Response
After uploading, the API returns the log file path:

```json
{
  "success": true,
  "message": "7 new videos uploaded, 2 already existed (skipped)",
  "sessionId": "upload_2024-01-15_10-30-45",
  "uploadLogFile": "./upload_logs/upload_2024-01-15_10-30-45.xlsx"
}
```

### Multiple Upload Sessions
Each time you upload, a new file is created:

```
upload_logs/
├── upload_2024-01-15_10-30-45.xlsx  # Morning batch
├── upload_2024-01-15_14-22-10.xlsx  # Afternoon batch
└── upload_2024-01-16_09-15-33.xlsx  # Next day
```

## Log Retention

- Logs are kept **forever** by default
- Manually delete old files if needed
- Each file is typically **10-50KB** (very small)
- Safe to archive to cloud storage

## Summary

**What**: One Excel file per upload session
**Where**: `upload_logs/` directory
**When**: Created automatically after each upload
**Why**: Complete audit trail of what happened and why
**How**: Open in Excel, search, filter, analyze

**No complexity. No databases. Just simple Excel files.** ✅

