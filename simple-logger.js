const path = require('path');
const XLSX = require('xlsx');
const fs = require('fs-extra');

class SimpleUploadLogger {
  constructor(logDir = './upload_logs') {
    this.logDir = logDir;
    this.currentSession = null;
    this.ensureLogDirectory();
  }

  ensureLogDirectory() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  // Start a new upload session
  startSession(totalFiles) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
    const time = new Date().toLocaleTimeString().replace(/:/g, '-');

    this.currentSession = {
      sessionId: `upload_${timestamp}_${time}`,
      startTime: new Date(),
      totalFiles: totalFiles,
      files: []
    };

    console.log(`\n${'='.repeat(80)}`);
    console.log(`📊 Upload Session Started: ${this.currentSession.sessionId}`);
    console.log(`   Total Files: ${totalFiles}`);
    console.log(`   Start Time: ${this.currentSession.startTime.toLocaleString()}`);
    console.log(`${'='.repeat(80)}\n`);

    return this.currentSession.sessionId;
  }

  // Log a file result
  logFile(data) {
    if (!this.currentSession) {
      console.warn('No active session');
      return;
    }

    const fileLog = {
      timestamp: new Date().toISOString(),
      fileName: data.fileName,
      status: data.status, // 'Uploaded', 'Skipped', 'Failed'
      videoId: data.videoId || 'N/A',
      videoTitle: data.videoTitle || path.parse(data.fileName).name,
      duration: data.duration || 'N/A',
      reason: data.reason || '',
      error: data.error || '',
      fileSize: this.formatBytes(data.fileSize || 0)
    };

    this.currentSession.files.push(fileLog);

    // Console output
    const emoji = data.status === 'Uploaded' ? '✅' :
                  data.status === 'Skipped' ? '⊘' : '❌';
    const msg = data.status === 'Uploaded' ? `→ Video ID: ${data.videoId}` :
                data.status === 'Skipped' ? `(${data.reason})` :
                `- ${data.error}`;

    console.log(`${emoji} ${data.fileName} ${msg}`);
  }

  // End session and generate Excel
  endSession() {
    if (!this.currentSession) {
      console.warn('No active session to end');
      return null;
    }

    const endTime = new Date();
    const duration = this.formatDuration(endTime - this.currentSession.startTime);

    // Count results
    const uploaded = this.currentSession.files.filter(f => f.status === 'Uploaded').length;
    const skipped = this.currentSession.files.filter(f => f.status === 'Skipped').length;
    const failed = this.currentSession.files.filter(f => f.status === 'Failed').length;

    console.log(`\n${'='.repeat(80)}`);
    console.log(`🏁 Upload Session Completed: ${this.currentSession.sessionId}`);
    console.log(`   Duration: ${duration}`);
    console.log(`   ✅ Uploaded: ${uploaded}`);
    console.log(`   ⊘ Skipped: ${skipped}`);
    console.log(`   ❌ Failed: ${failed}`);

    // Generate Excel file
    const excelFile = this.generateExcel();
    console.log(`   📊 Log saved to: ${excelFile}`);
    console.log(`${'='.repeat(80)}\n`);

    const summary = {
      sessionId: this.currentSession.sessionId,
      startTime: this.currentSession.startTime,
      endTime: endTime,
      duration: duration,
      totalFiles: this.currentSession.totalFiles,
      uploaded: uploaded,
      skipped: skipped,
      failed: failed,
      logFile: excelFile
    };

    this.currentSession = null;
    return summary;
  }

  // Generate Excel file
  generateExcel() {
    if (!this.currentSession) {
      return null;
    }

    const workbook = XLSX.utils.book_new();

    // Summary sheet
    const summaryData = [
      ['Upload Session Report'],
      [''],
      ['Session ID:', this.currentSession.sessionId],
      ['Start Time:', this.currentSession.startTime.toLocaleString()],
      ['End Time:', new Date().toLocaleString()],
      ['Total Files:', this.currentSession.totalFiles],
      [''],
      ['Results Summary:'],
      ['Uploaded:', this.currentSession.files.filter(f => f.status === 'Uploaded').length],
      ['Skipped:', this.currentSession.files.filter(f => f.status === 'Skipped').length],
      ['Failed:', this.currentSession.files.filter(f => f.status === 'Failed').length],
    ];

    const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary');

    // Details sheet
    const detailsData = [
      ['File Name', 'Status', 'Video ID', 'Video Title', 'Duration (seconds)', 'File Size', 'Reason/Error', 'Timestamp']
    ];

    this.currentSession.files.forEach(file => {
      detailsData.push([
        file.fileName,
        file.status,
        file.videoId,
        file.videoTitle,
        file.duration,
        file.fileSize,
        file.reason || file.error,
        new Date(file.timestamp).toLocaleString()
      ]);
    });

    const detailsSheet = XLSX.utils.aoa_to_sheet(detailsData);
    XLSX.utils.book_append_sheet(workbook, detailsSheet, 'Upload Details');

    // Save file
    const fileName = `${this.currentSession.sessionId}.xlsx`;
    const filePath = path.join(this.logDir, fileName);

    XLSX.writeFile(workbook, filePath);

    return filePath;
  }

  // Format bytes to human readable
  formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  // Format duration
  formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  // Get all log files
  getAllLogs() {
    try {
      const files = fs.readdirSync(this.logDir)
        .filter(f => f.endsWith('.xlsx'))
        .sort()
        .reverse();

      return files.map(file => ({
        fileName: file,
        filePath: path.join(this.logDir, file),
        createdAt: fs.statSync(path.join(this.logDir, file)).mtime
      }));
    } catch (error) {
      return [];
    }
  }
}

module.exports = SimpleUploadLogger;
