const DEFAULT_MAX_WAIT_MS = 10000;
const DEFAULT_TARGET_ACCURACY_METERS = 35;
export const MAX_ACCEPTABLE_GPS_ACCURACY_METERS = 150;

const isUsablePosition = (position) => (
  Number.isFinite(position?.coords?.latitude)
  && Number.isFinite(position?.coords?.longitude)
  && Number.isFinite(position?.coords?.accuracy)
);

export const getRefinedPosition = ({
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  targetAccuracyMeters = DEFAULT_TARGET_ACCURACY_METERS
} = {}) => (
  new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('This browser does not support GPS location.'));
      return;
    }

    let bestPosition = null;
    let lastError = null;
    let watchId = null;
    let timerId = null;

    const cleanup = () => {
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      if (timerId != null) window.clearTimeout(timerId);
    };

    const finish = () => {
      cleanup();

      if (bestPosition) {
        resolve(bestPosition);
        return;
      }

      reject(lastError || new Error('Unable to capture GPS location. Please enable location access and try again.'));
    };

    watchId = navigator.geolocation.watchPosition(
      (position) => {
        if (!isUsablePosition(position)) return;

        if (!bestPosition || position.coords.accuracy < bestPosition.coords.accuracy) {
          bestPosition = position;
        }

        if (bestPosition.coords.accuracy <= targetAccuracyMeters) {
          finish();
        }
      },
      (error) => {
        lastError = error;

        if (error.code === error.PERMISSION_DENIED) {
          cleanup();
          reject(error);
        }
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: maxWaitMs
      }
    );

    timerId = window.setTimeout(finish, maxWaitMs);
  })
);

export const requireUsableGpsAccuracy = (position) => {
  const accuracy = Math.round(position?.coords?.accuracy || Number.POSITIVE_INFINITY);

  if (accuracy > MAX_ACCEPTABLE_GPS_ACCURACY_METERS) {
    throw new Error(`GPS accuracy is currently +/-${accuracy}m. Move near a window or outdoors, then try again.`);
  }

  return position;
};

export const toLocationRecord = (position, capturedAtMs = Date.now()) => ({
  latitude: position.coords.latitude,
  longitude: position.coords.longitude,
  accuracy: Math.round(position.coords.accuracy),
  capturedAtMs
});
