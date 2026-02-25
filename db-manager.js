const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');

class UploadDatabase {
  constructor(dbPath = './uploads.db') {
    this.db = new Database(dbPath);
    this.initDatabase();
  }

  initDatabase() {
    // Create uploads table with indexed columns for fast lookups
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS uploads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_name TEXT NOT NULL,
        file_path TEXT,
        file_size INTEGER NOT NULL,
        file_hash TEXT NOT NULL,
        video_id TEXT,
        video_title TEXT,
        duration INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        error_message TEXT,
        uploaded_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(file_hash, file_size)
      );

      CREATE INDEX IF NOT EXISTS idx_file_hash ON uploads(file_hash);
      CREATE INDEX IF NOT EXISTS idx_status ON uploads(status);
      CREATE INDEX IF NOT EXISTS idx_video_id ON uploads(video_id);
      CREATE INDEX IF NOT EXISTS idx_file_name ON uploads(file_name);
    `);
  }

  // Fast file hash calculation using streams (memory efficient)
  calculateFileHash(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 }); // 1MB chunks

      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  // Check if file already uploaded (by hash + size)
  isFileUploaded(fileHash, fileSize) {
    const stmt = this.db.prepare(`
      SELECT * FROM uploads
      WHERE file_hash = ? AND file_size = ? AND status = 'success'
      LIMIT 1
    `);
    return stmt.get(fileHash, fileSize);
  }

  // Get file status
  getFileStatus(fileHash, fileSize) {
    const stmt = this.db.prepare(`
      SELECT * FROM uploads
      WHERE file_hash = ? AND file_size = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `);
    return stmt.get(fileHash, fileSize);
  }

  // Insert or update upload record
  upsertUpload(data) {
    const stmt = this.db.prepare(`
      INSERT INTO uploads (
        file_name, file_path, file_size, file_hash, video_id,
        video_title, duration, status, error_message, uploaded_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(file_hash, file_size) DO UPDATE SET
        file_name = excluded.file_name,
        file_path = excluded.file_path,
        video_id = excluded.video_id,
        video_title = excluded.video_title,
        duration = excluded.duration,
        status = excluded.status,
        error_message = excluded.error_message,
        uploaded_at = excluded.uploaded_at,
        updated_at = CURRENT_TIMESTAMP
    `);

    return stmt.run(
      data.file_name,
      data.file_path,
      data.file_size,
      data.file_hash,
      data.video_id || null,
      data.video_title || null,
      data.duration || null,
      data.status,
      data.error_message || null,
      data.uploaded_at || null
    );
  }

  // Mark upload as successful
  markSuccess(fileHash, fileSize, videoId, videoTitle) {
    const stmt = this.db.prepare(`
      UPDATE uploads
      SET status = 'success',
          video_id = ?,
          video_title = ?,
          uploaded_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP,
          error_message = NULL
      WHERE file_hash = ? AND file_size = ?
    `);
    return stmt.run(videoId, videoTitle, fileHash, fileSize);
  }

  // Mark upload as failed
  markFailed(fileHash, fileSize, errorMessage) {
    const stmt = this.db.prepare(`
      UPDATE uploads
      SET status = 'failed',
          error_message = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE file_hash = ? AND file_size = ?
    `);
    return stmt.run(errorMessage, fileHash, fileSize);
  }

  // Get all uploads with specific status
  getUploadsByStatus(status) {
    const stmt = this.db.prepare(`
      SELECT * FROM uploads WHERE status = ? ORDER BY created_at DESC
    `);
    return stmt.all(status);
  }

  // Get upload statistics
  getStats() {
    const stmt = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(file_size) as total_size
      FROM uploads
    `);
    return stmt.get();
  }

  // Get all successful uploads
  getSuccessfulUploads() {
    const stmt = this.db.prepare(`
      SELECT * FROM uploads WHERE status = 'success' ORDER BY uploaded_at DESC
    `);
    return stmt.all();
  }

  // Clean old failed uploads (optional)
  cleanOldFailed(daysOld = 30) {
    const stmt = this.db.prepare(`
      DELETE FROM uploads
      WHERE status = 'failed'
      AND updated_at < datetime('now', '-' || ? || ' days')
    `);
    return stmt.run(daysOld);
  }

  // Close database connection
  close() {
    this.db.close();
  }

  // Get video ID by hash (for quick lookup)
  getVideoIdByHash(fileHash, fileSize) {
    const stmt = this.db.prepare(`
      SELECT video_id FROM uploads
      WHERE file_hash = ? AND file_size = ? AND status = 'success'
      LIMIT 1
    `);
    const result = stmt.get(fileHash, fileSize);
    return result ? result.video_id : null;
  }
}

module.exports = UploadDatabase;
