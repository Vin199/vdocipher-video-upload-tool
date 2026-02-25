const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const XLSX = require('xlsx');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const UploadDatabase = require('./db-manager');
const VdoCipherVerifier = require('./vdocipher-verifier');
const SimpleUploadLogger = require('./simple-logger');
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

// Initialize database, verifier, and simple logger
const uploadDb = new UploadDatabase('./uploads.db');
const vdocipherVerifier = new VdoCipherVerifier(VDOCIPHER_API_KEY, API_BASE_URL);
const logger = new SimpleUploadLogger('./upload_logs');

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

// Smart file verification - checks if file needs uploading
async function verifyFileNeedsUpload(filePath, fileName, fileSize) {
  try {
    // Calculate file hash (efficient streaming)
    const fileHash = await uploadDb.calculateFileHash(filePath);

    // Check database first (fastest)
    const existingRecord = uploadDb.isFileUploaded(fileHash, fileSize);

    if (existingRecord) {
      console.log(`✓ File already uploaded: "${fileName}" (Video ID: ${existingRecord.video_id})`);
      return {
        needsUpload: false,
        reason: 'already_uploaded',
        videoId: existingRecord.video_id,
        hash: fileHash,
        existingRecord
      };
    }

    // Check if previously failed
    const failedRecord = uploadDb.getFileStatus(fileHash, fileSize);
    if (failedRecord && failedRecord.status === 'failed') {
      console.log(`⚠ File previously failed, will retry: "${fileName}"`);
      return {
        needsUpload: true,
        reason: 'retry_failed',
        hash: fileHash,
        previousError: failedRecord.error_message
      };
    }

    // New file - needs upload
    return {
      needsUpload: true,
      reason: 'new_file',
      hash: fileHash
    };
  } catch (error) {
    console.error(`Error verifying file ${fileName}:`, error.message);
    return {
      needsUpload: true,
      reason: 'verification_error',
      error: error.message
    };
  }
}

// Batch verification for all files
async function batchVerifyFiles(files) {
  const verificationTasks = files.map(file => async () => {
    const result = await verifyFileNeedsUpload(file.path, file.originalname, file.size);
    return {
      file,
      verification: result
    };
  });

  // Verify in parallel (fast)
  return await processInBatches(verificationTasks, 10);
}

app.post("/api/upload-videos", upload.array("videos"), async (req, res) => {
  let sessionId = null;

  try {
    const videoData = JSON.parse(req.body.videoData || "[]");
    const uploadErrors = [];
    const successfulUploads = [];
    const skippedUploads = [];

    // Start simple logging session
    sessionId = logger.startSession(req.files.length);

    // STEP 1: Batch verify all files (parallel hash calculation)
    const verificationResults = await batchVerifyFiles(req.files);

    // Separate files that need upload vs already uploaded
    const filesToUpload = [];
    const filesAlreadyUploaded = [];

    verificationResults.forEach(({ file, verification }) => {
      if (verification.needsUpload) {
        filesToUpload.push({ file, verification });
      } else {
        filesAlreadyUploaded.push({ file, verification });

        const metadata = videoData.find(v => v.name === file.originalname);
        skippedUploads.push({
          title: path.parse(file.originalname).name,
          videoId: verification.videoId,
          duration: metadata ? metadata.duration : "Unknown",
          originalName: file.originalname,
          reason: verification.reason,
          skipped: true
        });

        // Log to simple logger
        logger.logFile({
          fileName: file.originalname,
          status: 'Skipped',
          videoId: verification.videoId,
          videoTitle: path.parse(file.originalname).name,
          duration: metadata ? metadata.duration : 'Unknown',
          reason: verification.reason,
          fileSize: file.size
        });
      }
    });

    // Clean up files that don't need upload
    filesAlreadyUploaded.forEach(({ file }) => {
      fs.removeSync(file.path);
    });

    // STEP 2: Upload only files that need it
    if (filesToUpload.length > 0) {
      const uploadTasks = filesToUpload.map(({ file, verification }) => async () => {
        try {
          await apiDelay();

          const videoTitle = path.parse(file.originalname).name;
          const metadata = videoData.find(v => v.name === file.originalname);
          const duration = metadata ? metadata.duration : 0;

          // Record upload attempt in database
          uploadDb.upsertUpload({
            file_name: file.originalname,
            file_path: file.path,
            file_size: file.size,
            file_hash: verification.hash,
            video_title: videoTitle,
            duration: duration,
            status: 'uploading'
          });

          const uploadCredentials = await getUploadCredentials(videoTitle);
          const uploadResult = await uploadToVdoCipher(file.path, uploadCredentials, file.originalname);

          // Mark as successful in database
          uploadDb.markSuccess(verification.hash, file.size, uploadResult.videoId, videoTitle);

          // Log to simple logger
          logger.logFile({
            fileName: file.originalname,
            status: 'Uploaded',
            videoId: uploadResult.videoId,
            videoTitle: videoTitle,
            duration: duration,
            reason: verification.reason === 'retry_failed' ? 'Retried after previous failure' : '',
            fileSize: file.size
          });

          // Clean up temp file
          fs.removeSync(file.path);

          const successResult = {
            title: videoTitle,
            videoId: uploadResult.videoId,
            duration,
            originalName: file.originalname,
            wasRetry: verification.reason === 'retry_failed'
          };

          successfulUploads.push(successResult);
          return successResult;

        } catch (err) {
          // Build comprehensive error message with optional chaining
          let fullErrorMessage = err?.message || 'Unknown error';

          // Add detailed API message if available
          if (err?.response?.data?.message) {
            const apiMessage = err.response.data.message
              .replace(/\\n/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();
            fullErrorMessage = `${fullErrorMessage} - ${apiMessage}`;
          } else if (err?.response?.data) {
            const apiData = typeof err.response.data === 'string'
              ? err.response.data
              : JSON.stringify(err.response.data);
            fullErrorMessage = `${fullErrorMessage} - ${apiData}`;
          }

          // Mark as failed in database
          uploadDb.markFailed(verification.hash, file.size, fullErrorMessage);

          // Log to simple logger with full error message
          logger.logFile({
            fileName: file.originalname,
            status: 'Failed',
            error: fullErrorMessage,
            fileSize: file.size
          });

          // Clean up temp file even on error
          fs.removeSync(file.path);

          // Collect detailed error information
          const errorInfo = {
            fileName: file.originalname,
            error: fullErrorMessage,
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
      const results = await processInBatches(uploadTasks, 5);

      // Filter out failed uploads (null values)
      const successfulResults = results.filter(Boolean);
    }

    // Combine successful uploads and skipped files
    const allSuccessfulUploads = [...successfulUploads, ...skippedUploads];

    // Check if any uploads were successful (including skipped)
    if (allSuccessfulUploads.length === 0) {
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

    // Create Excel file with all results
    const worksheetData = [
      ["Video Title", "Video ID", "Duration (seconds)", "Status", "Notes"],
      ...allSuccessfulUploads.map(r => [
        r.title,
        r.videoId,
        r.duration,
        r.skipped ? "Skipped (Already Uploaded)" : (r.wasRetry ? "Success (Retry)" : "Success"),
        r.skipped ? "File already exists in VdoCipher" : ""
      ])
    ];

    // Add failed uploads to Excel for reference
    if (uploadErrors.length > 0) {
      uploadErrors.forEach(error => {
        worksheetData.push([
          path.parse(error.fileName).name,
          "FAILED",
          "N/A",
          "Failed",
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

    // End logging session and get the log file path
    const sessionSummary = logger.endSession();
    const uploadLogFile = sessionSummary?.logFile;

    // Return appropriate response based on results
    const totalProcessed = req.files.length;
    const totalSkipped = skippedUploads.length;
    const totalNewUploads = successfulUploads.length;
    const totalFailed = uploadErrors.length;

    if (uploadErrors.length === 0) {
      // All successful (including skipped)
      const message = totalSkipped > 0
        ? `${totalNewUploads} new videos uploaded, ${totalSkipped} already existed (skipped)`
        : `All ${totalNewUploads} videos uploaded successfully`;

      res.json({
        success: true,
        message,
        excelFileName,
        results: {
          total: totalProcessed,
          newUploads: totalNewUploads,
          skipped: totalSkipped,
          successful: allSuccessfulUploads.length,
          failed: 0
        },
        successfulUploads: allSuccessfulUploads,
        resumeInfo: {
          enabled: true,
          skippedFiles: totalSkipped,
          canRerunSafely: true
        },
        sessionId: sessionSummary?.sessionId,
        uploadLogFile: uploadLogFile
      });
    } else {
      // Partial success
      const message = totalSkipped > 0
        ? `${totalNewUploads} uploaded, ${totalSkipped} skipped, ${totalFailed} failed`
        : `${totalNewUploads} of ${totalProcessed} videos uploaded successfully`;

      res.status(207).json({ // 207 Multi-Status
        success: true,
        message,
        excelFileName,
        warning: "Some uploads failed - safe to re-run",
        results: {
          total: totalProcessed,
          newUploads: totalNewUploads,
          skipped: totalSkipped,
          successful: allSuccessfulUploads.length,
          failed: totalFailed
        },
        successfulUploads: allSuccessfulUploads,
        failedUploads: uploadErrors,
        resumeInfo: {
          enabled: true,
          skippedFiles: totalSkipped,
          canRerunSafely: true,
          failedCanRetry: true
        },
        sessionId: sessionSummary?.sessionId,
        uploadLogFile: uploadLogFile
      });
    }

  } catch (error) {
    // End session on error
    if (sessionId) {
      logger.endSession();
    }

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
  const stats = uploadDb.getStats();

  res.json({
    status: 'Server is running - Smart Resume Mode',
    apiKeyConfigured: VDOCIPHER_API_KEY !== 'your_api_key_here',
    mode: 'smart_resume_enabled',
    features: {
      smartResume: true,
      deduplication: true,
      hashBasedVerification: true,
      persistentTracking: true,
      frontendDurationExtraction: true,
      backgroundVideoProcessing: true,
      instantExcelDownload: true,
      noPollingNeeded: true
    },
    config: {
      maxFileSize: `${(MAX_FILE_SIZE / (1024 * 1024 * 1024)).toFixed(1)}GB`,
      defaultFolderId: DEFAULT_FOLDER_ID,
      apiDelayBetweenCalls: `${API_DELAY_BETWEEN_CALLS}ms`
    },
    uploadStats: {
      totalTracked: stats.total,
      successful: stats.successful,
      failed: stats.failed,
      pending: stats.pending,
      totalSize: `${(stats.total_size / (1024 * 1024 * 1024)).toFixed(2)}GB`
    }
  });
});

// Route to get upload history
app.get('/api/upload-history', (req, res) => {
  try {
    const stats = uploadDb.getStats();
    const successfulUploads = uploadDb.getSuccessfulUploads();
    const failedUploads = uploadDb.getUploadsByStatus('failed');

    res.json({
      stats: {
        total: stats.total,
        successful: stats.successful,
        failed: stats.failed,
        pending: stats.pending,
        totalSize: stats.total_size
      },
      recent: {
        successful: successfulUploads.slice(0, 50), // Last 50 successful
        failed: failedUploads.slice(0, 50) // Last 50 failed
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to fetch upload history',
      details: error.message
    });
  }
});

// Route to clear failed uploads from database
app.post('/api/clear-failed', (req, res) => {
  try {
    const daysOld = req.body.daysOld || 30;
    const result = uploadDb.cleanOldFailed(daysOld);

    res.json({
      success: true,
      message: `Cleared ${result.changes} old failed upload records`,
      clearedCount: result.changes
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to clear old uploads',
      details: error.message
    });
  }
});

// Route to get all upload logs
app.get('/api/upload-logs', (req, res) => {
  try {
    const logs = logger.getAllLogs();
    res.json({
      success: true,
      count: logs.length,
      logs: logs
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to fetch upload logs',
      details: error.message
    });
  }
});

// Route to download a specific upload log
app.get('/api/upload-logs/:fileName', (req, res) => {
  try {
    const logFile = path.join('./upload_logs', req.params.fileName);

    if (!fs.existsSync(logFile)) {
      return res.status(404).json({
        error: 'Log file not found'
      });
    }

    res.download(logFile);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to download log file',
      details: error.message
    });
  }
});

// Cleanup temp directory on startup
const tempDir = path.join(__dirname, 'temp_uploads');
if (fs.existsSync(tempDir)) {
  fs.emptyDirSync(tempDir);
}

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📂 Open http://localhost:${PORT} to start uploading`);
});