// One-off probe — lists buckets reachable with the configured S3 creds
// so we can see exactly what name the user created. Used to debug
// "Bucket not found" mismatches between Supabase dashboard and env.
import { S3Client } from 'bun';

const endpoint = process.env.SUPABASE_STORAGE_ENDPOINT!;
const accessKeyId = process.env.SUPABASE_STORAGE_ACCESS_KEY_ID!;
const secretAccessKey = process.env.SUPABASE_STORAGE_SECRET_KEY!;

if (!endpoint || !accessKeyId || !secretAccessKey) {
  console.error('Missing SUPABASE_STORAGE_* envs');
  process.exit(1);
}

// Try a small write to each candidate bucket name to see which works.
const candidates = ['axon', 'AXON', 'Axon', 'axon-documents', 'documents'];
const tinyBytes = new TextEncoder().encode('probe');

for (const bucket of candidates) {
  const c = new S3Client({
    accessKeyId, secretAccessKey, endpoint, bucket, region: 'us-east-1',
  });
  try {
    await c.write('__probe.txt', tinyBytes, { type: 'text/plain' });
    console.log(`OK  ${bucket}  — bucket exists, write succeeded`);
    await c.delete('__probe.txt').catch(() => {});
  } catch (e: any) {
    console.log(`ERR ${bucket}  — ${(e.message || String(e)).slice(0, 120)}`);
  }
}
