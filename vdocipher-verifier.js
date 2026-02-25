const axios = require('axios');

class VdoCipherVerifier {
  constructor(apiKey, apiBaseUrl = 'https://dev.vdocipher.com/api') {
    this.apiKey = apiKey;
    this.apiBaseUrl = apiBaseUrl;
    this.videoCache = new Map(); // In-memory cache for API responses
  }

  // Get all videos from VdoCipher (with pagination)
  async getAllVideos(limit = 100) {
    try {
      const videos = [];
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const response = await axios.get(`${this.apiBaseUrl}/videos`, {
          headers: {
            'Authorization': `Apisecret ${this.apiKey}`,
            'Accept': 'application/json'
          },
          params: {
            limit,
            offset
          }
        });

        const fetchedVideos = response.data.rows || [];
        videos.push(...fetchedVideos);

        // Cache videos for quick lookup
        fetchedVideos.forEach(video => {
          this.videoCache.set(video.id, video);
          this.videoCache.set(video.title, video);
        });

        hasMore = fetchedVideos.length === limit;
        offset += limit;

        // Rate limit protection
        if (hasMore) {
          await this.delay(200);
        }
      }

      return videos;
    } catch (error) {
      console.error('Error fetching videos from VdoCipher:', error.response?.data || error.message);
      throw error;
    }
  }

  // Check if video exists by title
  async videoExistsByTitle(title) {
    // Check cache first
    if (this.videoCache.has(title)) {
      return this.videoCache.get(title);
    }

    try {
      const videos = await this.getAllVideos();
      const video = videos.find(v => v.title === title);
      return video || null;
    } catch (error) {
      console.error('Error checking video existence:', error.message);
      return null;
    }
  }

  // Get video details by ID
  async getVideoById(videoId) {
    // Check cache first
    if (this.videoCache.has(videoId)) {
      return this.videoCache.get(videoId);
    }

    try {
      const response = await axios.get(`${this.apiBaseUrl}/videos/${videoId}`, {
        headers: {
          'Authorization': `Apisecret ${this.apiKey}`,
          'Accept': 'application/json'
        }
      });

      const video = response.data;
      this.videoCache.set(videoId, video);
      return video;
    } catch (error) {
      if (error.response?.status === 404) {
        return null;
      }
      console.error('Error fetching video by ID:', error.response?.data || error.message);
      throw error;
    }
  }

  // Verify video file size matches
  async verifyVideoFileSize(videoId, expectedSize, tolerance = 1024 * 1024) {
    try {
      const video = await this.getVideoById(videoId);
      if (!video) return false;

      const actualSize = video.length || video.size || 0;
      const sizeDiff = Math.abs(actualSize - expectedSize);

      // Allow 1MB tolerance for encoding differences
      return sizeDiff <= tolerance;
    } catch (error) {
      console.error('Error verifying file size:', error.message);
      return false;
    }
  }

  // Batch verify multiple videos (efficient)
  async batchVerifyByTitles(titles) {
    const videos = await this.getAllVideos();
    const results = {};

    titles.forEach(title => {
      const video = videos.find(v => v.title === title);
      results[title] = video || null;
    });

    return results;
  }

  // Clear cache (useful for forcing refresh)
  clearCache() {
    this.videoCache.clear();
  }

  // Helper delay function
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Check video status (processing, ready, etc.)
  async getVideoStatus(videoId) {
    try {
      const video = await this.getVideoById(videoId);
      if (!video) return null;

      return {
        id: video.id,
        title: video.title,
        status: video.status,
        length: video.length,
        isReady: video.status === 'ready',
        processingFailed: video.status === 'failed'
      };
    } catch (error) {
      console.error('Error getting video status:', error.message);
      return null;
    }
  }
}

module.exports = VdoCipherVerifier;
