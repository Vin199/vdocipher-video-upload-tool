# VdoCipher Bulk Uploader - Setup & Usage Guide

## Prerequisites
- **Node.js** installed (v14 or higher)
- **VdoCipher API key** (get from your VdoCipher dashboard)

---

## Setup Steps

### 1. Copy Project Folder
Transfer the entire `vdocipher-bulk-uploader` folder to the Mac using:
- USB drive
- Cloud storage (Google Drive, Dropbox, etc.)
- Email/WeTransfer
- Git clone (if hosted on GitHub)

### 2. Open Terminal & Navigate to Project
```bash
cd /path/to/vdocipher-bulk-uploader
```

Example:
```bash
cd ~/Desktop/vdocipher-bulk-uploader
```

### 3. Install Dependencies
```bash
npm install
```

This will install all required packages:
- express
- axios
- multer
- better-sqlite3
- xlsx
- dotenv
- cors
- form-data
- fs-extra

**Wait for installation to complete** (takes 1-2 minutes)

### 4. Create Environment File

Create a file named `.env` in the project root folder.

### 5. Add Configuration to Environment File

Open the `.env` file and add the following:

```
VDOCIPHER_API_KEY=your_actual_api_key_here
PORT=4000
MAX_FILE_SIZE=5368709120
API_DELAY_BETWEEN_CALLS=500
DEFAULT_FOLDER_ID=root
```

**Replace `your_actual_api_key_here` with your real VdoCipher API key!**

**Configuration Details:**
- `VDOCIPHER_API_KEY` - Your API key from VdoCipher dashboard (REQUIRED)
- `PORT` - Server runs on this port (default: 4000)
- `MAX_FILE_SIZE` - Maximum file size in bytes (default: 5GB)
- `API_DELAY_BETWEEN_CALLS` - Delay between API calls in milliseconds
- `DEFAULT_FOLDER_ID` - VdoCipher folder ID (use "root" for main folder)

### 6. Start the Server

```bash
npm run dev
```

You should see:
```
[nodemon] starting `node server.js`
🚀 VdoCipher Smart Uploader running on port 4000
✅ Upload database initialized
```

**Keep this terminal window open!** The server must run while uploading.

### 7. Open Browser

Open your web browser and go to:
```
http://localhost:4000
```

You should see the VdoCipher Bulk Uploader interface.

---

## Using the Uploader

### Step 1: Select Videos
- Click **"Select Video Files"** button, or
- **Drag & drop** videos directly onto the page

### Step 2: Wait for Processing
- Videos are processed automatically
- Duration is extracted for unencrypted videos
- You'll see status for each file:
  - ✅ Ready
  - ⏳ Processing
  - ❌ Error (if metadata extraction fails)

### Step 3: Click "Start Upload"
- Upload starts automatically
- Progress shown for each file in real-time
- 5 videos upload simultaneously for speed

### Step 4: Monitor Progress
**File Status Indicators:**
- 🟡 **Pending** - Waiting to upload
- 🔵 **Uploading** - Currently uploading
- 🟢 **Uploaded** - Successfully uploaded
- ⚪ **Skipped (Already Uploaded)** - File already exists on VdoCipher
- 🔴 **Failed** - Upload failed (see error message)

### Step 5: View Results
After upload completes, you'll see:
- **Total uploaded** count
- **Total skipped** count (already uploaded before)
- **Total failed** count
- **Download Excel Report** button

### Step 6: Download Excel Report
- Click **"Download Excel Report"** button
- Opens Excel file with two sheets:
  - **Summary** - Total counts, session info, timestamps
  - **Details** - Per-file information with status, video ID, duration, errors

---

## Important Features

### ✅ Smart Resume
- **Safe to re-run**: Upload the same batch multiple times
- **Already uploaded files are automatically skipped**
- **Failed uploads are automatically retried**
- Database tracks all uploads using file hash + size

### ✅ Duplicate Prevention
- Files identified by content (SHA-256 hash), not just name
- Same video with different filename = automatically skipped
- Prevents accidental duplicate uploads

### ✅ Memory Efficient
- Streams files in 64KB chunks
- Can upload 5GB videos using minimal RAM
- 5 concurrent uploads for speed

### ✅ Comprehensive Logging
- Excel report for every upload session
- Tracks: filename, status, video ID, duration, errors, timestamps
- Reports saved in `upload_logs/` folder

---

## Understanding Upload Messages

### Success Messages
- **"🎉 Upload Completed Successfully!"** - All files uploaded (none skipped/failed)
- **"🎉 Upload Completed!"** - Some uploaded + some skipped (no failures)
- **"ℹ️ All Files Already Uploaded"** - All files were skipped (already existed)

### Partial Success Messages
- **"⚠️ Upload Partially Completed"** - Some succeeded, some failed
  - Shows breakdown: "X uploaded, Y skipped, Z failed"
  - Safe to re-run for failed files

### Failure Messages
- **"❌ All Uploads Failed"** - All files failed to upload
  - Check error messages for each file
  - Common causes: API key issue, trial limit reached, network error

---

## Files & Folders Generated

### During Operation
- **`uploads.db`** - SQLite database tracking all uploads (persistent)
- **`temp_uploads/`** - Temporary folder for file processing (auto-cleaned)
- **`upload_logs/`** - Excel reports for each session

### Excel Report Naming
Format: `upload_YYYYMMDD_HHMMSS.xlsx`

Example: `upload_20250225_143022.xlsx`
- Uploaded on: 2025-02-25
- At time: 14:30:22

---

## Common Issues & Solutions

### Issue: "All uploads failed"
**Possible Causes:**
- Invalid VdoCipher API key
- Trial limit reached (free accounts: 4-5 videos)
- Network connectivity issue

**Solutions:**
1. Verify API key in environment file
2. Check VdoCipher dashboard for quota/limits
3. Check error messages in Excel report for details

### Issue: "Failed to load video metadata"
**Cause:** Encrypted videos cannot have metadata extracted by browser

**Solution:** This is normal for encrypted videos - they will upload without duration info

### Issue: Server won't start
**Possible Causes:**
- Port 4000 already in use
- npm packages not installed
- Environment file missing

**Solutions:**
1. Check if another app uses port 4000
2. Run `npm install` again
3. Create environment file with required variables

### Issue: Files showing as "already uploaded" but they were deleted from VdoCipher
**Explanation:** This is expected behavior!

The local database (`uploads.db`) tracks uploads based on file content hash. Even if you delete videos from VdoCipher, the local database still has records.

**Solution:**
- The tool skips these files to prevent duplicate uploads
- If you truly want to re-upload, you can:
  1. Delete `uploads.db` file (resets all history), or
  2. Modify the file slightly (changes hash), or
  3. Manually remove specific records from database

### Issue: Database locked error
**Cause:** Multiple server instances running

**Solution:**
1. Stop all terminal windows running the server
2. Run `npm run dev` in only ONE terminal

---

## Viewing Database Records

To see what's tracked in the database:

```bash
sqlite3 uploads.db "SELECT * FROM uploads;"
```

Or for formatted output:
```bash
sqlite3 uploads.db
.mode column
.headers on
SELECT file_name, status, video_id, uploaded_at FROM uploads;
.quit
```

---

## Stopping the Server

In the terminal where server is running:
- Press `Ctrl + C` (Mac/Linux)
- Server stops immediately
- Temporary files are cleaned automatically

---

## Performance Tips

### For Faster Uploads
1. Use wired internet (not WiFi) for large batches
2. Don't run other heavy tasks while uploading
3. Upload in batches of 50-100 files at a time

### For Large Files (2GB+)
1. Ensure stable internet connection
2. Don't close browser tab during upload
3. Keep laptop plugged in (prevent sleep)

---

## Advanced: Viewing Upload Statistics

Access server statistics via browser:

**Get server status:**
```
http://localhost:4000/api/status
```

**Get upload history:**
```
http://localhost:4000/api/upload-history
```

---

## Security Notes

⚠️ **Keep your environment file secure!**
- Never share environment file with anyone
- Never commit environment file to Git/GitHub
- API key gives full access to your VdoCipher account

---

## Support & Troubleshooting

### Check Logs
**Server-side logs:** Check terminal where `npm run dev` is running

**Client-side logs:** Open browser Developer Tools (F12) → Console tab

### Database Inspection
```bash
sqlite3 uploads.db "SELECT COUNT(*) as total FROM uploads;"
sqlite3 uploads.db "SELECT COUNT(*) as successful FROM uploads WHERE status='success';"
sqlite3 uploads.db "SELECT COUNT(*) as failed FROM uploads WHERE status='failed';"
```

---

## Quick Reference Commands

```bash
# Navigate to project
cd /path/to/vdocipher-bulk-uploader

# Install dependencies
npm install

# Start server
npm run dev

# Stop server
Ctrl + C

# View database records
sqlite3 uploads.db "SELECT * FROM uploads LIMIT 10;"

# Check upload statistics
sqlite3 uploads.db "SELECT status, COUNT(*) FROM uploads GROUP BY status;"
```

---

## Summary Checklist

- [ ] Node.js installed
- [ ] Project folder copied to Mac
- [ ] `npm install` completed successfully
- [ ] Environment file created with API key
- [ ] Server started with `npm run dev`
- [ ] Browser opened to `http://localhost:4000`
- [ ] Videos uploaded successfully
- [ ] Excel report downloaded

---

**That's it! You're ready to upload videos to VdoCipher in bulk! 🚀**
