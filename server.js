const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const XLSX = require('xlsx');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const https = require('https');
const http = require('http');
const UploadDatabase = require('./db-manager');
const VdoCipherVerifier = require('./vdocipher-verifier');
const SimpleUploadLogger = require('./simple-logger');
require('dotenv').config();

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 50 // Increased to handle more concurrent connections
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50 // Increased to handle more concurrent connections
});

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

// Store SSE clients for progress updates
const sseClients = new Map();

// Helper function to add delay between API calls
async function apiDelay(ms = API_DELAY_BETWEEN_CALLS) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper function to send SSE progress updates
function sendProgress(sessionId, data) {
  const client = sseClients.get(sessionId);
  if (client) {
    client.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

// Check if API key is set
if (VDOCIPHER_API_KEY === 'your_api_key_here') {
  console.warn('⚠️  WARNING: Please set your VdoCipher API key in the .env file or environment variables');
}

// Middleware
app.use(cors());
// Increase body parser limits to handle large JSON arrays (for 1000+ videos metadata)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({
  limit: '50mb',
  extended: true,
  parameterLimit: 100000 // Increase parameter limit for many files
}));
app.use(express.static('public'));

// Configure multer for temporary file storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'temp_uploads';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
    }
    console.log(`📁 Multer receiving file: ${file.originalname}`);
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const filename = `${Date.now()}-${file.originalname}`;
    console.log(`💾 Multer saving file as: ${filename}`);
    cb(null, filename);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: MAX_FILE_SIZE, // Max file size per file (10GB)
    files: 10000, // Max number of files (supports bulk upload of 1000+ videos)
    fieldSize: 50 * 1024 * 1024, // Max field size (50MB for large JSON metadata)
    fields: 1000 // Max number of non-file fields
  }
});

// Middleware to clean old temp files BEFORE multer processes
function cleanTempFolderMiddleware(req, res, next) {
  try {
    console.log(`🔵 cleanTempFolderMiddleware called for ${req.method} ${req.path}`);
    const tempDir = path.join(__dirname, 'temp_uploads');

    // Only clean for upload endpoint
    if (req.path === '/api/upload-videos' && req.method === 'POST') {
      console.log(`🧹 Starting temp folder cleanup...`);
      if (fs.existsSync(tempDir)) {
        const files = fs.readdirSync(tempDir);
        // Only clean if there are old files (more than 1 minute old)
        const now = Date.now();
        files.forEach(file => {
          const filePath = path.join(tempDir, file);
          const stats = fs.statSync(filePath);
          const fileAge = now - stats.mtimeMs;

          // Delete files older than 1 minute (60000 ms)
          if (fileAge > 60000) {
            try {
              fs.removeSync(filePath);
              console.log(`🧹 Cleaned old temp file: ${file} (age: ${Math.round(fileAge/1000)}s)`);
            } catch (e) {
              console.warn(`⚠️ Could not delete old file: ${file}`, e.message);
            }
          }
        });
      }
    }
  } catch (error) {
    console.warn('Warning: Could not clean temp folder:', error.message);
  }
  next();
}

// Multer error handling middleware
function handleMulterError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    // Multer-specific errors
    console.error('Multer error:', err.code, err.message);

    const errorMessages = {
      'LIMIT_FILE_SIZE': `File too large. Maximum size is ${(MAX_FILE_SIZE / (1024 * 1024 * 1024)).toFixed(1)}GB per file.`,
      'LIMIT_FILE_COUNT': 'Too many files. Maximum is 10000 files per upload.',
      'LIMIT_FIELD_KEY': 'Field name too long.',
      'LIMIT_FIELD_VALUE': 'Field value too long.',
      'LIMIT_FIELD_COUNT': 'Too many fields.',
      'LIMIT_UNEXPECTED_FILE': 'Unexpected file field.',
      'LIMIT_PART_COUNT': 'Too many parts in multipart request.'
    };

    return res.status(400).json({
      success: false,
      error: errorMessages[err.code] || `Upload error: ${err.message}`,
      code: err.code
    });
  } else if (err) {
    // Other errors
    console.error('Upload error:', err);
    return res.status(500).json({
      success: false,
      error: 'Server error during file upload',
      details: err.message
    });
  }
  next();
}

// Helper function to get upload credentials from VdoCipher
async function getUploadCredentials(videoTitle, folderId = DEFAULT_FOLDER_ID) {
  try {    
    // Create query string manually to ensure proper formatting
    const queryParams = new URLSearchParams({
      title: videoTitle,
      folderId: folderId
    });
    const url = `${API_BASE_URL}/videos?${queryParams.toString()}`;
    const response = await axios({
      method: 'PUT',
      url: url,
      headers: {
        'Authorization': `Apisecret ${VDOCIPHER_API_KEY}`,
        'Accept': 'application/json'
      }
    });
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

// Helper function to upload file to VdoCipher with retry logic
async function uploadToVdoCipher(filePath, uploadData, originalName, retryCount = 0) {
  const MAX_RETRIES = 2; // Retry up to 2 times for timeout errors

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
      maxBodyLength: Infinity,
      timeout: 0, // No timeout - allow unlimited time for large file uploads
      httpAgent: httpAgent,
      httpsAgent: httpsAgent
    });

    return {
      success: true,
      videoId: uploadData.videoId,
      data: response.data
    };
  } catch (error) {
    const errorData = error.response?.data || error.message;
    const isTimeoutError = typeof errorData === 'string' && errorData.includes('RequestTimeout');

    // Retry only for timeout errors
    if (isTimeoutError && retryCount < MAX_RETRIES) {
      console.log(`⚠️ Timeout uploading ${originalName}, retrying (${retryCount + 1}/${MAX_RETRIES})...`);
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds before retry
      return uploadToVdoCipher(filePath, uploadData, originalName, retryCount + 1);
    }

    console.error('Error uploading to VdoCipher:', errorData);
    throw error;
  }
}

async function processInBatches(tasks, limit) {
  const results = [];
  let index = 0;

  // Non-recursive worker function (prevents stack overflow with many files)
  async function runWorker() {
    while (index < tasks.length) {
      const currentIndex = index++;
      try {
        const result = await tasks[currentIndex]();
        results[currentIndex] = result;
      } catch (error) {
        console.error(`Error in batch task ${currentIndex}:`, error);
        results[currentIndex] = null; // Mark as failed
      }
    }
  }

  // Start `limit` workers in parallel
  const workers = [];
  for (let i = 0; i < Math.min(limit, tasks.length); i++) {
    workers.push(runWorker());
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
async function batchVerifyFiles(files, sseSessionId = null) {
  let completed = 0;
  const total = files.length;

  const verificationTasks = files.map(file => async () => {
    const result = await verifyFileNeedsUpload(file.path, file.originalname, file.size);

    completed++;
    if (sseSessionId) {
      sendProgress(sseSessionId, {
        type: 'hash_progress',
        current: completed,
        total: total,
        fileName: file.originalname,
        message: `Verifying file ${completed}/${total}: ${file.originalname}`
      });
    }

    return {
      file,
      verification: result
    };
  });

  // Verify in parallel (fast)
  return await processInBatches(verificationTasks, 10);
}

app.post("/api/upload-videos", (req, res, next) => {
  console.log(`🔵 Upload endpoint hit - Starting multer processing...`);
  upload.array("videos")(req, res, (err) => {
    if (err) {
      console.error(`❌ Multer failed:`, err);
      return handleMulterError(err, req, res, next);
    }
    console.log(`✅ Multer completed! Received ${req.files ? req.files.length : 0} files`);
    next();
  });
}, async (req, res) => {
  let logSessionId = null;
  let clientDisconnected = false;

  console.log(`\n${'='.repeat(80)}`);
  console.log(`📥 UPLOAD HANDLER CALLED - Processing files`);
  console.log(`   Files received: ${req.files ? req.files.length : 0}`);
  console.log(`   Body size: ${JSON.stringify(req.body).length} bytes`);
  console.log(`${'='.repeat(80)}\n`);

  // Detect client disconnect
  req.on('close', () => {
    if (!res.headersSent) {
      clientDisconnected = true;
      console.error('❌ CLIENT DISCONNECTED DURING UPLOAD PROCESSING');
    }
  });

  try {
    // Parse video metadata first
    const videoData = JSON.parse(req.body.videoData || "[]");
    const uploadErrors = [];
    const successfulUploads = [];
    const skippedUploads = [];

    // CRITICAL VALIDATION: Ensure file count matches metadata count
    if (req.files.length !== videoData.length) {
      console.error(`⚠️ File count mismatch! Files: ${req.files.length}, Metadata: ${videoData.length}`);
      console.error(`This usually means old temp files from previous failed uploads.`);

      // Return error to prevent processing wrong number of files
      return res.status(400).json({
        success: false,
        error: `File count mismatch: Received ${req.files.length} files but ${videoData.length} metadata entries. Please refresh and try again.`,
        details: {
          filesReceived: req.files.length,
          metadataCount: videoData.length
        }
      });
    }

    // Get SSE session ID from request
    const sseSessionId = req.body.sessionId || req.query.sessionId;

    // Start simple logging session
    logSessionId = logger.startSession(req.files.length);

    // Send initial progress
    if (sseSessionId) {
      sendProgress(sseSessionId, {
        type: 'start',
        total: req.files.length,
        message: `Starting upload of ${req.files.length} videos...`
      });
    }

    // STEP 1: Batch verify all files (parallel hash calculation)
    console.log(`🔍 Starting hash verification for ${req.files.length} files...`);
    if (sseSessionId) {
      sendProgress(sseSessionId, {
        type: 'verifying',
        message: `Verifying ${req.files.length} files...`
      });
    }

    const verificationResults = await batchVerifyFiles(req.files, sseSessionId);
    console.log(`✓ Hash verification complete. Results: ${verificationResults.length}`);

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
          fileSize: file.size,
          folderPath: metadata ? metadata.folderPath : file.originalname
        });
      }
    });

    // Clean up files that don't need upload
    filesAlreadyUploaded.forEach(({ file }) => {
      fs.removeSync(file.path);
    });

    // STEP 2: Upload only files that need it
    if (filesToUpload.length > 0) {
      let uploadedCount = 0;
      const totalToUpload = filesToUpload.length;

      if (sseSessionId) {
        sendProgress(sseSessionId, {
          type: 'upload_start',
          total: totalToUpload,
          skipped: filesAlreadyUploaded.length,
          message: `Uploading ${totalToUpload} videos (${filesAlreadyUploaded.length} skipped)...`
        });
      }

      const uploadTasks = filesToUpload.map(({ file, verification }) => async () => {
        // Define metadata outside try block so it's accessible in catch
        const metadata = videoData.find(v => v.name === file.originalname);
        const videoTitle = path.parse(file.originalname).name;
        const duration = metadata ? metadata.duration : 0;

        try {
          await apiDelay();

          // Send progress: Starting upload
          if (sseSessionId) {
            sendProgress(sseSessionId, {
              type: 'upload_file',
              current: uploadedCount + 1,
              total: totalToUpload,
              fileName: file.originalname,
              fileSize: file.size,
              message: `Uploading ${uploadedCount + 1}/${totalToUpload}: ${file.originalname}`
            });
          }

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

          uploadedCount++;

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
            fileSize: file.size,
            folderPath: metadata ? metadata.folderPath : file.originalname
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
            fileSize: file.size,
            folderPath: metadata ? metadata.folderPath : file.originalname
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

    // Send completion progress
    const totalProcessed = req.files.length;
    const totalSkipped = skippedUploads.length;
    const totalNewUploads = successfulUploads.length;
    const totalFailed = uploadErrors.length;

    if (sseSessionId) {
      sendProgress(sseSessionId, {
        type: 'complete',
        total: totalProcessed,
        uploaded: totalNewUploads,
        skipped: totalSkipped,
        failed: totalFailed,
        message: `Upload complete: ${totalNewUploads} uploaded, ${totalSkipped} skipped, ${totalFailed} failed`
      });
    }

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

// Route to download combined Excel from multiple batches
app.post('/api/download-combined', (req, res) => {
  try {
    const { files } = req.body;

    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    console.log(`📊 Combining ${files.length} Excel files into one report...`);

    // Read all Excel files and combine them
    const allRows = [];
    const logDir = path.join(__dirname, 'upload_logs');

    files.forEach((filename, index) => {
      const filePath = path.join(logDir, filename);

      if (fs.existsSync(filePath)) {
        console.log(`   Reading batch ${index + 1}: ${filename}`);
        const workbook = XLSX.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(worksheet);

        // Add batch information to each row
        rows.forEach(row => {
          row['Batch'] = index + 1;
          allRows.push(row);
        });
      } else {
        console.warn(`   ⚠️ File not found: ${filename}`);
      }
    });

    if (allRows.length === 0) {
      return res.status(404).json({ error: 'No data found in provided files' });
    }

    // Create new workbook with combined data
    const newWorkbook = XLSX.utils.book_new();
    const newWorksheet = XLSX.utils.json_to_sheet(allRows);

    // Auto-size columns
    const colWidths = [
      { wch: 50 }, // File Name
      { wch: 15 }, // Status
      { wch: 35 }, // Video ID
      { wch: 30 }, // Video Title
      { wch: 10 }, // Duration
      { wch: 15 }, // File Size
      { wch: 50 }, // Folder Path
      { wch: 50 }, // Error
      { wch: 10 }  // Batch
    ];
    newWorksheet['!cols'] = colWidths;

    XLSX.utils.book_append_sheet(newWorkbook, newWorksheet, 'Combined Upload Report');

    // Generate file
    const combinedFileName = `combined_upload_report_${Date.now()}.xlsx`;
    const combinedFilePath = path.join(__dirname, 'temp_uploads', combinedFileName);

    XLSX.writeFile(newWorkbook, combinedFilePath);

    console.log(`✅ Combined report created: ${allRows.length} total rows from ${files.length} batches`);

    // Send file
    res.download(combinedFilePath, combinedFileName, (err) => {
      if (!err) {
        // Clean up combined file after download
        setTimeout(() => {
          fs.removeSync(combinedFilePath);
        }, 5000);
      }
    });

  } catch (error) {
    console.error('Error creating combined report:', error);
    res.status(500).json({ error: 'Failed to create combined report', details: error.message });
  }
});

// Route to get server status and configuration
// SSE endpoint for real-time upload progress
app.get('/api/upload-progress/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;

  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable buffering in nginx

  // Store this client
  sseClients.set(sessionId, res);

  console.log(`📡 SSE client connected: ${sessionId}`);

  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Connected to progress stream' })}\n\n`);

  // Handle client disconnect
  req.on('close', () => {
    console.log(`📡 SSE client disconnected: ${sessionId}`);
    sseClients.delete(sessionId);
  });
});

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
      noPollingNeeded: true,
      realTimeProgress: true // New feature
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

const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📂 Open http://localhost:${PORT} to start uploading`);
});

// Disable server timeout to handle unlimited videos (production-ready)
// Client-side timeout (30 min) provides protection against hanging requests
server.timeout = 0; // 0 = no timeout (handles any number of videos)
server.keepAliveTimeout = 65000; // 65 seconds
server.headersTimeout = 66000; // 66 seconds (must be > keepAliveTimeout)

// Global error handlers to catch crashes
process.on('uncaughtException', (error) => {
  console.error('❌ UNCAUGHT EXCEPTION:', error);
  console.error('Stack:', error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ UNHANDLED REJECTION at:', promise);
  console.error('Reason:', reason);
});