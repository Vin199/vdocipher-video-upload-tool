const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const XLSX = require('xlsx');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const VDOCIPHER_API_KEY = process.env.VDOCIPHER_API_KEY || 'your_api_key_here';
const API_BASE_URL = 'https://dev.vdocipher.com/api';
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024 * 1024; // 5GB
const DEFAULT_FOLDER_ID = process.env.DEFAULT_FOLDER_ID || 'root';

// API Rate Limiting - minimal delays since we're not polling
const API_DELAY_BETWEEN_CALLS = parseInt(process.env.API_DELAY_BETWEEN_CALLS) || 500; // 0.5 second between API calls

// Helper function to add delay between API calls
async function apiDelay(ms = API_DELAY_BETWEEN_CALLS) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Check if API key is set
if (VDOCIPHER_API_KEY === 'your_api_key_here') {
  console.warn('⚠️  WARNING: Please set your VdoCipher API key in the .env file or environment variables');
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configure multer for temporary file storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'temp_uploads';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: MAX_FILE_SIZE // Configurable file size limit
  }
});

// Helper function to get upload credentials from VdoCipher
async function getUploadCredentials(videoTitle, folderId = DEFAULT_FOLDER_ID) {
  try {
    console.log(`Getting upload credentials for: "${videoTitle}"`);
    
    // Create query string manually to ensure proper formatting
    const queryParams = new URLSearchParams({
      title: videoTitle,
      folderId: folderId
    });
    
    const url = `${API_BASE_URL}/videos?${queryParams.toString()}`;
    console.log(`API URL: ${url}`);
    
    const response = await axios({
      method: 'PUT',
      url: url,
      headers: {
        'Authorization': `Apisecret ${VDOCIPHER_API_KEY}`,
        'Accept': 'application/json'
      }
    });
    
    console.log(`✅ Upload credentials obtained for: "${videoTitle}"`);
    return response.data;
  } catch (error) {
    console.error(`❌ Failed to get credentials for: "${videoTitle}"`);
    console.error('Full error response:', {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      headers: error.response?.headers
    });
    throw error;
  }
}

// Helper function to upload file to VdoCipher
async function uploadToVdoCipher(filePath, uploadData, originalName) {
  try {
    const form = new FormData();
    
    // Add all required fields from upload credentials
    form.append('policy', uploadData.clientPayload.policy);
    form.append('key', uploadData.clientPayload.key);
    form.append('x-amz-signature', uploadData.clientPayload['x-amz-signature']);
    form.append('x-amz-algorithm', uploadData.clientPayload['x-amz-algorithm']);
    form.append('x-amz-date', uploadData.clientPayload['x-amz-date']);
    form.append('x-amz-credential', uploadData.clientPayload['x-amz-credential']);
    form.append('success_action_status', '201');
    form.append('success_action_redirect', '');
    
    // Add the file - this must be last
    form.append('file', fs.createReadStream(filePath), {
      filename: originalName,
      contentType: 'video/*'
    });

    const response = await axios.post(uploadData.clientPayload.uploadLink, form, {
      headers: {
        ...form.getHeaders(),
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    return {
      success: true,
      videoId: uploadData.videoId,
      data: response.data
    };
  } catch (error) {
    console.error('Error uploading to VdoCipher:', error.response?.data || error.message);
    throw error;
  }
}

async function processInBatches(tasks, limit) {
  const results = [];
  let index = 0;

  async function runNext() {
    if (index >= tasks.length) return;
    const currentIndex = index++;
    const result = await tasks[currentIndex]();
    results[currentIndex] = result;
    await runNext();
  }

  // Start `limit` workers
  const workers = [];
  for (let i = 0; i < limit; i++) {
    workers.push(runNext());
  }

  await Promise.all(workers);
  return results;
}

app.post("/api/upload-videos", upload.array("videos"), async (req, res) => {
  try {
    const videoData = JSON.parse(req.body.videoData || "[]");
    const uploadErrors = [];
    const successfulUploads = [];

    const uploadTasks = req.files.map((file, index) => async () => {
      try {
        await apiDelay();
        
        const uploadCredentials = await getUploadCredentials(path.parse(file.originalname).name);
        const uploadResult = await uploadToVdoCipher(file.path, uploadCredentials, file.originalname);

        const metadata = videoData.find(v => v.name === file.originalname);
        const duration = metadata ? metadata.duration : "Unknown";

        // Clean up temp file
        fs.removeSync(file.path);

        const successResult = {
          title: path.parse(file.originalname).name,
          videoId: uploadResult.videoId,
          duration,
          originalName: file.originalname
        };

        successfulUploads.push(successResult);
        return successResult;

      } catch (err) {
        console.error("Error uploading:", file.originalname, err.message);
        
        // Clean up temp file even on error
        fs.removeSync(file.path);
        
        // Collect detailed error information
        const errorInfo = {
          fileName: file.originalname,
          error: err.message,
          status: err.response?.status,
          statusText: err.response?.statusText,
          apiResponse: err.response?.data,
          timestamp: new Date().toISOString()
        };
        
        uploadErrors.push(errorInfo);
        return null;
      }
    });

    // Run uploads with concurrency limit of 5
    console.log(`Starting upload of ${req.files.length} files...`);
    const results = await processInBatches(uploadTasks, 5);
    
    // Filter out failed uploads (null values)
    const successfulResults = results.filter(Boolean);

    console.log(`Upload completed: ${successfulResults.length} successful, ${uploadErrors.length} failed`);

    // Check if any uploads were successful
    if (successfulResults.length === 0) {
      // ALL uploads failed
      console.error("All uploads failed!");
      return res.status(400).json({
        error: "All video uploads failed",
        details: "None of the videos could be uploaded to VdoCipher",
        failedUploads: uploadErrors.length,
        totalUploads: req.files.length,
        errors: uploadErrors,
        success: false
      });
    }

    // Some or all uploads were successful - create Excel file
    const worksheetData = [
      ["Video Title", "Video ID", "Duration (seconds)", "Status"],
      ...successfulResults.map(r => [r.title, r.videoId, r.duration, "Success"])
    ];

    // Add failed uploads to Excel for reference
    if (uploadErrors.length > 0) {
      uploadErrors.forEach(error => {
        worksheetData.push([
          path.parse(error.fileName).name, 
          "FAILED", 
          "N/A", 
          `Error: ${error.error}`
        ]);
      });
    }

    const worksheet = XLSX.utils.aoa_to_sheet(worksheetData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Video Uploads");

    const excelFileName = `video_uploads_${Date.now()}.xlsx`;
    const excelFilePath = path.join(__dirname, "temp_uploads", excelFileName);

    XLSX.writeFile(workbook, excelFilePath);

    // Return appropriate response based on results
    if (uploadErrors.length === 0) {
      // All uploads successful
      res.json({
        success: true,
        message: `All ${successfulResults.length} videos uploaded successfully`,
        excelFileName,
        results: {
          total: req.files.length,
          successful: successfulResults.length,
          failed: 0
        },
        successfulUploads: successfulResults
      });
    } else {
      // Partial success
      res.status(207).json({ // 207 Multi-Status
        success: true,
        message: `${successfulResults.length} of ${req.files.length} videos uploaded successfully`,
        excelFileName,
        warning: "Some uploads failed",
        results: {
          total: req.files.length,
          successful: successfulResults.length,
          failed: uploadErrors.length
        },
        successfulUploads: successfulResults,
        failedUploads: uploadErrors
      });
    }

  } catch (error) {
    console.error("Critical error in upload process:", error);
    
    // Clean up any remaining temp files
    if (req.files) {
      req.files.forEach(file => {
        try {
          fs.removeSync(file.path);
        } catch (cleanupError) {
          console.error("Error cleaning up file:", file.path, cleanupError.message);
        }
      });
    }

    res.status(500).json({ 
      error: "Server error during upload process",
      details: error.message,
      success: false
    });
  }
});

// Route to download Excel file
app.get('/api/download/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'temp_uploads', filename);
  
  if (fs.existsSync(filePath)) {
    res.download(filePath, (err) => {
      if (!err) {
        // Clean up file after download
        setTimeout(() => {
          fs.removeSync(filePath);
        }, 5000);
      }
    });
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

// Route to get server status and configuration
app.get('/api/status', (req, res) => {
  res.json({ 
    status: 'Server is running - Fast Mode',
    apiKeyConfigured: VDOCIPHER_API_KEY !== 'your_api_key_here',
    mode: 'fast_upload_only',
    features: {
      frontendDurationExtraction: true,
      backgroundVideoProcessing: true,
      instantExcelDownload: true,
      noPollingNeeded: true
    },
    config: {
      maxFileSize: `${(MAX_FILE_SIZE / (1024 * 1024 * 1024)).toFixed(1)}GB`,
      defaultFolderId: DEFAULT_FOLDER_ID,
      apiDelayBetweenCalls: `${API_DELAY_BETWEEN_CALLS}ms`
    }
  });
});

// Cleanup temp directory on startup
const tempDir = path.join(__dirname, 'temp_uploads');
if (fs.existsSync(tempDir)) {
  fs.emptyDirSync(tempDir);
}

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📂 Open http://localhost:${PORT} to start uploading`);
  
  if (VDOCIPHER_API_KEY === 'your_api_key_here') {
    console.log(`⚠️  Remember to set your VdoCipher API key in .env file`);
  } else {
    console.log(`✅ API key configured`);
  }
});