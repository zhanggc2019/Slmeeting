use anyhow::{anyhow, Context, Result};
use rubato::{FftFixedIn, Resampler};
use std::fs::File;
use std::path::Path;
use symphonia::core::audio::{AudioBufferRef, SampleBuffer, SignalSpec};
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::default::{get_codecs, get_probe};

/// Decoded mono audio normalized to the sample rate expected by local ASR.
pub struct DecodedAudio {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

/// Decode a common audio file into mono floating point samples.
pub fn decode_audio_file(path: &Path) -> Result<DecodedAudio> {
    let file = File::open(path)
        .with_context(|| format!("failed to open audio file: {}", path.display()))?;
    let source = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }

    let probed = get_probe()
        .format(
            &hint,
            source,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .context("failed to detect audio format")?;
    let track = probed
        .format
        .default_track()
        .ok_or_else(|| anyhow!("audio file has no decodable track"))?;
    let codec_params = &track.codec_params;
    let sample_rate = codec_params
        .sample_rate
        .ok_or_else(|| anyhow!("audio file has no sample rate"))?;
    let channels = codec_params
        .channels
        .ok_or_else(|| anyhow!("audio file has no channel information"))?
        .count();
    if channels == 0 {
        return Err(anyhow!("audio file has zero channels"));
    }

    let mut decoder = get_codecs()
        .make(codec_params, &DecoderOptions::default())
        .context("failed to create audio decoder")?;
    let mut samples = Vec::new();

    loop {
        let packet = match probed.format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::ResetRequired) => {
                return Err(anyhow!("audio decoder requested a reset"));
            }
            Err(SymphoniaError::IoError(error)) => {
                if error.kind() == std::io::ErrorKind::UnexpectedEof {
                    break;
                }
                return Err(error).context("failed while reading audio packets");
            }
            Err(error) => return Err(error).context("failed while reading audio packets"),
        };

        let decoded = decoder
            .decode(&packet)
            .context("failed to decode audio packet")?;
        append_mono_samples(decoded, &mut samples);
    }

    if samples.is_empty() {
        return Err(anyhow!("audio file contains no samples"));
    }

    Ok(DecodedAudio {
        samples,
        sample_rate,
    })
}

/// Append an arbitrary decoded audio buffer as mono samples.
fn append_mono_samples(buffer: AudioBufferRef<'_>, output: &mut Vec<f32>) {
    let spec: SignalSpec = *buffer.spec();
    let channels = spec.channels.count();
    let mut sample_buffer = SampleBuffer::<f32>::new(buffer.capacity() as u64, spec);
    sample_buffer.copy_interleaved_ref(buffer);
    let interleaved = sample_buffer.samples();

    if channels == 1 {
        output.extend_from_slice(interleaved);
        return;
    }

    for frame in interleaved.chunks(channels) {
        let sum: f32 = frame.iter().copied().sum();
        output.push(sum / channels as f32);
    }
}

/// Resample mono audio to the 16 kHz rate expected by Handy ASR models.
pub fn resample_to_16khz(samples: &[f32], sample_rate: u32) -> Result<Vec<f32>> {
    if sample_rate == 16_000 {
        return Ok(samples.to_vec());
    }
    if sample_rate == 0 {
        return Err(anyhow!("audio sample rate must be greater than zero"));
    }

    let input_chunk = 1024;
    let mut resampler = FftFixedIn::<f32>::new(sample_rate as usize, 16_000, input_chunk, 1, 1)
        .context("failed to initialize audio resampler")?;
    let mut output =
        Vec::with_capacity(((samples.len() as u64 * 16_000) / sample_rate as u64) as usize + 1024);
    let mut offset = 0;

    while offset + input_chunk <= samples.len() {
        let chunk = &samples[offset..offset + input_chunk];
        let converted = resampler
            .process(&[chunk], None)
            .context("failed to resample audio")?;
        output.extend_from_slice(&converted[0]);
        offset += input_chunk;
    }

    if offset < samples.len() {
        let converted = resampler
            .process_partial(Some(&[&samples[offset..]]), None)
            .context("failed to resample final audio chunk")?;
        output.extend_from_slice(&converted[0]);
    }

    Ok(output)
}
