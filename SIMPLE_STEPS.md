# How to Upload Videos - Simple Steps

## First Time Setup (Do Once)

### Step 1: Install Node.js
- Download from: https://nodejs.org
- Install it on your Mac
- Restart your computer

### Step 2: Open Project Folder
- Find the `vdocipher-bulk-uploader` folder
- Right-click on the folder
- Click "New Terminal at Folder" (or open Terminal and drag the folder into it)

### Step 3: Install Required Files
In the Terminal window, type:
```bash
npm install
```
Press Enter and wait (takes 1-2 minutes)

### Step 4: Add Your API Key
- In the project folder, find the file named `.env`
- Open it with TextEdit or any text editor
- Replace `your_actual_api_key_here` with your real VdoCipher API key
- Save the file

**That's it! Setup is complete.**

---

## Every Time You Want to Upload Videos

### Step 1: Open Terminal in Project Folder
- Go to the `vdocipher-bulk-uploader` folder
- Right-click → "New Terminal at Folder"

### Step 2: Start the Tool
In Terminal, type:
```bash
npm run dev
```
Press Enter

You'll see: `🚀 VdoCipher Smart Uploader running on port 4000`

**Keep this window open!**

### Step 3: Open Your Browser
- Open Chrome, Safari, or any browser
- Go to: `http://localhost:4000`

### Step 4: Upload Videos
1. Click **"Select Video Files"** or drag-and-drop your videos
2. Wait for videos to process (few seconds)
3. Click **"Start Upload"** button
4. Wait for uploads to complete
5. Click **"Download Excel Report"** to see results

### Step 5: Done! Close Everything
- Close the browser tab
- Go back to Terminal
- Press `Ctrl + C` to stop the tool

---

## Understanding the Results

- **Green "Uploaded"** = Video successfully uploaded
- **White "Skipped"** = Video already uploaded before (safe!)
- **Red "Failed"** = Upload failed (check error message)

---

## Tips

✅ **Safe to re-run**: If some videos fail, just repeat Step 1-5. Already uploaded videos will be skipped automatically!

✅ **Reports saved**: Every upload creates an Excel file in the `upload_logs` folder

✅ **Don't close**: Keep browser and Terminal open while uploading

---

## Quick Reference

**Start the tool:**
```bash
npm run dev
```

**Open in browser:**
```
http://localhost:4000
```

**Stop the tool:**
Press `Ctrl + C` in Terminal

---

That's all you need! 🎉
