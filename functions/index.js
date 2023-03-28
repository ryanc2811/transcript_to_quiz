const functions = require("firebase-functions");
const admin = require("firebase-admin");
const os = require('os');
const path = require('path');
const fs = require('fs');
const { Storage } = require('@google-cloud/storage');
const speech = require('@google-cloud/speech').v1p1beta1;
const { exec } = require('child_process');
admin.initializeApp();

const gcs = new Storage();
const client = new speech.SpeechClient();



exports.extractTranscript = functions.region('europe-west2').storage.object().onFinalize(async (object) => {
    const bucketName = object.bucket;
    const filePath = object.name;
  
    const bucket = admin.storage().bucket(bucketName);
    const file = bucket.file(filePath);
  
    const tempFilePath = path.join(os.tmpdir(), path.basename(filePath));
    await file.download({destination: tempFilePath}, (err) => {
      if (err) {
        console.error('Error downloading file:', err);
        return;
      }
      console.log('File downloaded successfully:', tempFilePath);
    });
      
    // Extract audio from video
    const audioFilePath = path.join(os.tmpdir(), path.basename(filePath, path.extname(filePath)) + '.flac');
    const audioExtractionCmd = `ffmpeg -i ${tempFilePath} -y -vn -acodec flac ${audioFilePath}`;
    await new Promise((resolve, reject) => {
      exec(audioExtractionCmd, (err, stdout, stderr) => {
        if (err) {
          console.error(err);
          return reject(err);
        }
        console.log('Audio extraction complete');
        resolve();
      });
    });
  
    // Transcribe audio
    const audioUri = `gs://${bucketName}/${path.basename(audioFilePath)}`;
    const audioConfig = {
      encoding: 'FLAC',
      languageCode: 'en-US',
      audioChannelCount: 2,
      enableSeparateRecognitionPerChannel: true,
      useEnhanced: true,
      model: 'video',
    };
    const request = {
      audio: {
        uri: audioUri,
      },
      config: audioConfig,
    };
    const [operation] = await client.longRunningRecognize(request);
    const [response] = await operation.promise();
  
    // Store transcript in Firestore
    const db = admin.firestore();
    const videoId = path.basename(filePath, path.extname(filePath));
    const transcript = response.results.map(result => result.alternatives[0].transcript).join('\n');
    await db.collection('videos').doc(videoId).set({
      transcript: transcript
    }, { merge: true });
  
    // Delete temporary files
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
      console.log('Temporary file deleted:', tempFilePath);
    } else {
      console.warn('Temporary file does not exist:', tempFilePath);
    }

    if (fs.existsSync(audioFilePath)) {
      fs.unlinkSync(audioFilePath);
      console.log('Audio file deleted:', audioFilePath);
    } else {
      console.warn('Audio file does not exist:', audioFilePath);
    }
  
    console.log('Transcription complete');
    console.log("Transcript saved to Firestore.");
});

exports.getTranscripts = functions.region('europe-west2').https.onCall(async (data, context) => {
    try {
      const db = admin.firestore();
      const transcriptsRef = db.collection("videos");
      const snapshot = await transcriptsRef.get();
      const transcripts = [];
  
      snapshot.forEach((doc) => {
        transcripts.push(doc.data());
      });
  
      return { transcripts };
    } catch (error) {
      console.log(error);
      return { error: error.message };
    }
  });