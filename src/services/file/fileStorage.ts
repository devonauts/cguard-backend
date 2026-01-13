import { getConfig } from '../../config';

let FileStorage;

// Default to 'localhost' storage when the env var is missing
const provider = (getConfig().FILE_STORAGE_PROVIDER || 'localhost').toString();

if (provider === 'gcp') {
  FileStorage = require('./googleCloudFileStorage').default;
} else if (provider === 'aws') {
  FileStorage = require('./awsFileStorage').default;
} else if (provider === 'localhost') {
  FileStorage = require('./localhostFileStorage').default;
} else {
  // As a safety fallback, default to localhost implementation
  FileStorage = require('./localhostFileStorage').default;
}

export default FileStorage;
