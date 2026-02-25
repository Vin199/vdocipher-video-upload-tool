# VdoCipher Bulk Uploader with Smart Resume

A powerful, efficient bulk video uploader for VdoCipher with intelligent resume capabilities and deduplication.

## ✨ Key Features

### 📊 Simple Upload Logging
- **One Excel File Per Upload**: Automatic log generation for each batch
- **Complete Details**: File name, status, video ID, duration, errors - all in Excel
- **Two Sheets**: Summary (counts, times) + Details (per-file info)
- **Easy to Use**: Open in Excel, search, filter, analyze
- **Portable**: Share log files via email
- **See**: [SIMPLE_LOGGING.md](SIMPLE_LOGGING.md) for details

### 🔄 Smart Resume Functionality
- **Safe to Re-run**: Upload the same batch multiple times without duplicates
- **Hash-based Verification**: Uses SHA-256 file hashing to detect identical files
- **Automatic Skip**: Already-uploaded files are automatically skipped
- **Failed Upload Retry**: Previously failed uploads are automatically retried
- **Persistent Tracking**: SQLite database tracks all upload history across sessions

### ⚡ Performance Optimizations
- **Parallel Hash Calculation**: Verify 10 files simultaneously
- **Concurrent Uploads**: Upload 5 videos at once
- **Stream-based Hashing**: Memory-efficient file processing (1MB chunks)
- **Indexed Database**: Fast lookups using hash + size indices
- **Batch Verification**: Check all files before starting uploads

### 📊 Upload Intelligence
- **Deduplication**: Never upload the same file twice
- **File Integrity**: Verifies files by content (hash), not just name
- **Partial Upload Detection**: Identifies and replaces incomplete uploads
- **Progress Persistence**: Resume uploads after server restart
- **Detailed Reporting**: Excel reports with upload status, skipped files, and errors

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Create a `.env` file:
```env
VDOCIPHER_API_KEY=your_api_key_here
PORT=4000
MAX_FILE_SIZE=5368709120
API_DELAY_BETWEEN_CALLS=500
DEFAULT_FOLDER_ID=root
```

### 3. Start Server
```bash
npm run dev
```

### 4. Upload Videos
Open `http://localhost:4000` in your browser and drag-and-drop your videos.

## 📖 How It Works

### Upload Flow
1. **File Selection**: User selects video files
2. **Client-side Processing**: Extract video duration (no server processing needed)
3. **Smart Verification**:
   - Calculate SHA-256 hash for each file
   - Check database for existing uploads
   - Identify files that need uploading
4. **Selective Upload**: Only upload new/failed files
5. **Database Update**: Track successful uploads
6. **Excel Generation**: Generate report with all results

### Resume Logic
```javascript
// First run: Upload 10 files
// Result: 8 success, 2 failed

// Second run: Upload same 10 files
// Result:
//   - 8 files skipped (already uploaded)
//   - 2 files retried (previously failed)
//   - Total: 10 files processed in seconds
```

## 🗄️ Database Schema

### uploads table
- `file_hash` (TEXT): SHA-256 hash of file content
- `file_size` (INTEGER): File size in bytes
- `file_name` (TEXT): Original filename
- `video_id` (TEXT): VdoCipher video ID
- `video_title` (TEXT): Video title
- `duration` (INTEGER): Video duration in seconds
- `status` (TEXT): pending | uploading | success | failed
- `uploaded_at` (DATETIME): Upload timestamp
- `error_message` (TEXT): Error details if failed

**Unique Constraint**: `(file_hash, file_size)` ensures no duplicates

## 📡 API Endpoints

### POST /api/upload-videos
Upload videos with smart resume
- **Request**: Multipart form with video files + metadata
- **Response**: Upload results with skipped/success/failed counts

### GET /api/status
Get server status and upload statistics
```json
{
  "status": "Server is running - Smart Resume Mode",
  "features": {
    "smartResume": true,
    "deduplication": true,
    "hashBasedVerification": true
  },
  "uploadStats": {
    "totalTracked": 150,
    "successful": 145,
    "failed": 5
  }
}
```

### GET /api/upload-history
Get upload history and statistics
```json
{
  "stats": {
    "total": 150,
    "successful": 145,
    "failed": 5
  },
  "recent": {
    "successful": [...],
    "failed": [...]
  }
}
```

### POST /api/clear-failed
Clear old failed upload records
```json
{
  "daysOld": 30
}
```

### GET /api/download/:filename
Download Excel report

## 🎯 Use Cases

### Scenario 1: Network Interruption
```
Upload 100 videos → Network fails at 60 files
Re-run → Skips 60 successful, uploads remaining 40
```

### Scenario 2: Partial Failures
```
Upload 50 videos → 45 succeed, 5 fail (API limit)
Re-run → Skips 45 successful, retries 5 failed
```

### Scenario 3: Duplicate Prevention
```
Same file uploaded with different names
System detects identical hash → Skips duplicate
```

## 📊 Excel Report Columns

1. **Video Title**: Name of the video
2. **Video ID**: VdoCipher video identifier
3. **Duration**: Video length in seconds
4. **Status**:
   - `Success` - Newly uploaded
   - `Success (Retry)` - Previously failed, now successful
   - `Skipped (Already Uploaded)` - File already exists
   - `Failed` - Upload failed
5. **Notes**: Additional information (errors, skip reasons)

## 🔧 Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VDOCIPHER_API_KEY` | - | Your VdoCipher API key (required) |
| `PORT` | 3000 | Server port |
| `MAX_FILE_SIZE` | 5GB | Maximum file size per video |
| `API_DELAY_BETWEEN_CALLS` | 500ms | Delay between VdoCipher API calls |
| `DEFAULT_FOLDER_ID` | root | VdoCipher folder for uploads |

### Performance Tuning

**Concurrent Hash Calculation**: Adjust in `server.js`
```javascript
return await processInBatches(verificationTasks, 10); // Change 10 to adjust
```

**Concurrent Uploads**: Adjust in `server.js`
```javascript
const results = await processInBatches(uploadTasks, 5); // Change 5 to adjust
```

## 🛡️ File Verification

### Hash Calculation
- **Algorithm**: SHA-256
- **Method**: Streaming (memory efficient)
- **Chunk Size**: 1MB
- **Purpose**: Content-based deduplication

### Verification Process
1. Calculate file hash (streaming, parallel)
2. Check database: `file_hash + file_size`
3. Determine action:
   - **Match found with status='success'** → Skip
   - **Match found with status='failed'** → Retry
   - **No match** → Upload

## 📈 Performance Metrics

### Speed Improvements
- **Hash Verification**: ~100-500 MB/s (SSD)
- **Parallel Hashing**: 10x faster than sequential
- **Skip Detection**: Instant (indexed DB lookup)
- **Re-run Time**: Seconds (vs minutes for full upload)

### Resource Usage
- **Memory**: ~50MB base + ~5MB per concurrent upload
- **Disk**: Database grows ~1KB per video record
- **Network**: Only uploads new/failed files

## 🔍 Troubleshooting

### Issue: "All uploads failed"
- **Cause**: VdoCipher API key issue or trial limit reached
- **Solution**: Verify API key in `.env`, check VdoCipher quota

### Issue: "File already uploaded but showing as new"
- **Cause**: File content changed (different hash)
- **Solution**: This is correct behavior - file is different

### Issue: Database locked
- **Cause**: Multiple server instances
- **Solution**: Stop other instances, restart server

### Issue: Hash calculation slow
- **Cause**: Large files on slow disk
- **Solution**: Reduce concurrent hash operations or use SSD

## 📝 Development

### Run in Development Mode
```bash
npm run dev
```

### Project Structure
```
├── server.js              # Main Express server
├── db-manager.js          # SQLite database operations
├── vdocipher-verifier.js  # VdoCipher API verification
├── public/
│   └── index.html         # Frontend UI
├── uploads.db             # SQLite database (auto-created)
└── temp_uploads/          # Temporary file storage
```

## 🎓 Advanced Usage

### Programmatic Access
```javascript
const UploadDatabase = require('./db-manager');
const db = new UploadDatabase();

// Check if file already uploaded
const hash = await db.calculateFileHash('/path/to/video.mp4');
const isUploaded = db.isFileUploaded(hash, fileSize);

// Get statistics
const stats = db.getStats();
console.log(`${stats.successful} successful uploads`);
```

## 🤝 Contributing

Contributions welcome! Please ensure:
- Hash-based verification remains efficient
- Database schema changes are backward compatible
- Frontend clearly shows skip/retry status

## 📄 License

ISC

## 🆘 Support

For issues or questions, please check:
1. Console logs (server-side errors)
2. Browser console (client-side errors)
3. Database contents: `sqlite3 uploads.db "SELECT * FROM uploads;"`
4. VdoCipher API status

---

**Built with**: Node.js, Express, SQLite, VdoCipher API
