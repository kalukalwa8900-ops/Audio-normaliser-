# Backend Connection Troubleshooting Guide

## Common Issues: Frontend Cannot Connect to Server

When the frontend shows **"failed to connect with server"** or **"network issue"**, this document helps identify and resolve the problem.

---

## Quick Diagnosis Checklist

Use this checklist **first** before diving into detailed sections:

- [ ] **Is the backend running?** Visit `https://YOUR-RAILWAY-URL/health` in your browser.
- [ ] **Is the Railway service deployed?** Check the Railway dashboard for status.
- [ ] **Is CORS enabled?** Check backend environment variables: `CORS_ORIGIN`.
- [ ] **Are frontend and backend on the same domain or correctly configured?**
- [ ] **Is there a network/firewall blocking the connection?**
- [ ] **Are you using HTTP (insecure) from HTTPS (secure) frontend?**
- [ ] **Did you disable "Demo Mode" in the frontend after connecting?**

---

## Issue 1: Backend Unavailable (`/health` returns 404 or fails)

### Symptom
- Browser cannot reach `https://YOUR-RAILWAY-URL/health`
- Returns **404** or **connection refused**

### Root Cause
- Backend is not running
- Wrong URL
- Railway service crashed
- Incorrect root directory in Railway config

### Solution

**Step 1: Verify Railway deployment**
1. Go to **Railway Dashboard** → Your Service
2. Check **Deployment Status**: should show ✅ **Active**
3. If it says **Failed**, click **View Logs** and look for startup errors

**Step 2: Verify correct URL**
1. In Railway → **Settings → Networking**, copy the **Public URL**
2. Make sure it's `https://` (not `http://`)
3. Test directly: `https://YOUR-RAILWAY-URL/health`

**Step 3: Check root directory**
1. In Railway → **Settings**, confirm **Root Directory** = `/backend`
2. If blank or wrong, update it:
   - Stop the service
   - Set **Root Directory** to `/backend`
   - Redeploy
3. Check logs: should show `Listening on 0.0.0.0:3000`

**Step 4: View backend logs for errors**
```bash
# In Railway dashboard → Logs tab
# Look for:
- "Listening on 0.0.0.0:3000" — good
- "ENOENT" or "module not found" — missing dependencies
- "FFmpeg not found" — ffmpeg not installed in Docker
- "ECONNREFUSED" — port already in use
```

---

## Issue 2: CORS Error (browser console shows CORS error)

### Symptom
Browser console shows:
```
Access to XMLHttpRequest at 'https://backend.railway.app/analyze' from origin 
'https://frontend.lovable.app' has been blocked by CORS policy
```

### Root Cause
- `CORS_ORIGIN` environment variable not set or misconfigured
- Frontend URL doesn't match `CORS_ORIGIN` exactly

### Solution

**Step 1: Set CORS_ORIGIN in Railway**
1. Railway → Your Service → **Variables**
2. Add/Edit `CORS_ORIGIN`:
   ```
   https://your-app.lovable.app
   ```
   OR for multiple origins:
   ```
   https://your-app.lovable.app,https://yourdomain.com
   ```
3. **Redeploy** the service

**Step 2: Verify frontend URL matches exactly**
- If frontend is at `https://your-app.lovable.app`, add that exact URL to `CORS_ORIGIN`
- If frontend is at `https://yourdomain.com`, add that exact URL
- Wildcards: Use `*` **only for testing** — never in production

**Step 3: Clear browser cache and restart**
1. Open Developer Tools → **Network** tab
2. Hard refresh: `Ctrl+Shift+R` (or `Cmd+Shift+R` on Mac)
3. Check the OPTIONS preflight request — it should return **200** with CORS headers

**Step 4: Test with curl**
```bash
curl -H "Origin: https://your-app.lovable.app" \
     -H "Access-Control-Request-Method: POST" \
     -v https://YOUR-RAILWAY-URL/health
```

Look for response headers:
```
Access-Control-Allow-Origin: https://your-app.lovable.app
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
```

---

## Issue 3: "Network Error" or "Failed to Fetch"

### Symptom
- Frontend shows **Network Error** or **Failed to Fetch**
- No CORS error in console
- `GET /health` works, but `POST /analyze` fails

### Root Cause
- Timeout during upload (file too large or slow network)
- Backend crashes during processing
- Server ran out of disk space
- Memory limit exceeded
- Invalid multipart/form-data request

### Solution

**Step 1: Check backend logs during upload**
```bash
# In Railway dashboard → Logs tab
# Upload a file and watch logs
# Look for:
- "413 Payload Too Large" → file exceeds MAX_UPLOAD_MB
- "ENOSPC" → out of disk space
- "out of memory" → process killed due to memory limit
```

**Step 2: Verify MAX_UPLOAD_MB setting**
1. Railway → Your Service → **Variables**
2. Check `MAX_UPLOAD_MB` (default: 2048 = 2GB)
3. If uploading > 2GB, increase it or split into smaller batches

**Step 3: Increase Railway resource limits**
1. Railway → Your Service → **Settings**
2. Under **Resources**, set:
   - **Memory**: at least **1GB** (for large batches)
   - **CPU**: at least **2 cores** (for concurrent processing)
3. **Redeploy**

**Step 4: Test with smaller file first**
- Try uploading a 50MB ZIP with 10 MP3s
- If it works, gradually increase size
- If it fails, check logs for specific error

**Step 5: Check network stability**
```bash
# Test with curl
curl -X POST \
  -F "file=@test.zip" \
  https://YOUR-RAILWAY-URL/analyze \
  -v
```

---

## Issue 4: `GET /health` Works, But `POST /analyze` Returns 400 or 500

### Symptom
- `/health` endpoint works fine
- `POST /analyze` returns **400** or **500**
- Error: `"ZIP file is required"` or similar

### Root Cause
- Form data not being sent correctly
- ZIP file not being read as multipart/form-data
- Invalid file format
- Backend crashed

### Solution

**Step 1: Check frontend upload code**

Verify the frontend is sending multipart form data:

```javascript
// ✅ CORRECT
const formData = new FormData();
formData.append('file', zipFile);  // zipFile is a File object

fetch(`${backendUrl}/analyze`, {
  method: 'POST',
  body: formData
  // DO NOT set Content-Type header — browser will set it automatically
})
```

**Step 2: Check with curl**
```bash
curl -X POST \
  -F "file=@your-file.zip" \
  https://YOUR-RAILWAY-URL/analyze \
  -v
```

Expected response: `202 { "jobId": "..." }`

**Step 3: View backend logs**
```
# Look for:
- "ZIP file is required" → file not being received
- "Only ZIP uploads are accepted" → file extension wrong
- "400 - Only ZIP uploads are accepted" → not a ZIP
```

**Step 4: Check Railway timeout settings**
1. Railway → Your Service → **Settings**
2. Look for **Build Timeout** or **Deployment Timeout**
3. Set to at least **15 minutes** for large uploads

---

## Issue 5: Upload Works, But Processing Never Completes

### Symptom
- File uploads successfully (returns `jobId`)
- `GET /jobs/:id` shows `status: "analyzing"` for 30+ minutes
- Processing seems stuck

### Root Cause
- FFmpeg crashes on corrupted MP3
- Disk space runs out during processing
- Worker process crashed silently
- Memory limit exceeded
- Concurrency set too high (causing resource contention)

### Solution

**Step 1: Check backend logs for specific file**
```bash
# In Railway logs, look for:
- "ffmpeg exited with code 1" — FFmpeg error on specific file
- "ENOSPC" — out of disk space
- "Killed" or "signal 9" — out of memory
```

**Step 2: Reduce PROCESS_CONCURRENCY**
1. Railway → Your Service → **Variables**
2. Set `PROCESS_CONCURRENCY=1` (start with serial processing)
3. **Redeploy** and retry

This ensures only one file processes at a time.

**Step 3: Increase server resources**
1. Railway → Your Service → **Settings**
2. Increase **Memory** to **2GB** or more
3. Increase **Disk** to **10GB** or more
4. **Redeploy**

**Step 4: Restart the service**
1. Railway → Your Service → **More** (⋮ menu)
2. Click **Restart**
3. Wait for it to come back online
4. Try again

**Step 5: Test with simple 10-file ZIP**
- Create a small test ZIP with 10 simple MP3s
- Upload and see if it processes
- If it works, gradually increase batch size

---

## Issue 6: Download Works But ZIP is Empty or Corrupted

### Symptom
- Processing completes successfully
- Download URL works
- Downloaded ZIP is empty or cannot be extracted

### Root Cause
- Output directory not created
- FFmpeg failed silently
- ZIP creation failed
- Files deleted prematurely (retention timer ran out)

### Solution

**Step 1: Check backend logs**
```
Look for:
- "Creating ZIP" stage — did it complete?
- "Verifying output" errors
- Any "ENOENT" (file not found) errors
```

**Step 2: Increase JOB_RETENTION_MINUTES**
1. Railway → Your Service → **Variables**
2. Set `JOB_RETENTION_MINUTES=240` (4 hours instead of default 60 minutes)
3. **Redeploy**

This prevents files from being deleted too quickly.

**Step 3: Manually verify processed files exist**
1. SSH into Railway container:
   ```bash
   railway run bash
   ```
2. Check output directory:
   ```bash
   ls -la /tmp/voice-batch-jobs/*/output/
   ```
3. If empty, check processing logs for errors

**Step 4: Test ZIP creation locally**
```bash
# Inside Railway container
zip -r /tmp/test.zip /tmp/voice-batch-jobs/*/output/
unzip -l /tmp/test.zip
```

---

## Issue 7: Frontend Shows "Demo Mode" Can't Be Disabled

### Symptom
- "Demo Mode" toggle is still on even after entering backend URL
- Shows warning: "Backend URL required to disable demo mode"
- When disabled, requests still go to demo API

### Root Cause
- Backend URL not being saved to localStorage
- `CORS_ORIGIN` not configured for frontend URL
- Frontend not clearing cache after URL change

### Solution

**Step 1: Clear browser data**
1. Open **Developer Tools** → **Application** (or **Storage**)
2. **Clear Storage** → **Clear All**
3. **Close and reopen** the frontend URL

**Step 2: Re-enter backend URL**
1. In the frontend Settings/Backend section
2. Enter: `https://YOUR-RAILWAY-URL` (without trailing slash)
3. Click **Connect** or **Verify**
4. Should show ✅ **Connected**

**Step 3: Disable Demo Mode**
1. Toggle should now work
2. Should show: Demo Mode: ⚠️ OFF
3. Hard refresh: `Ctrl+Shift+R`

**Step 4: Verify localStorage**
Open **DevTools → Console** and run:
```javascript
console.log(localStorage.getItem('backendUrl'));
```

Should return: `https://YOUR-RAILWAY-URL`

---

## Issue 8: "Railway URL" Invalid or Doesn't Work

### Symptom
- Can't find the Railway public URL
- URL changes every time service restarts
- Frontend can't reach the URL

### Root Cause
- Railway domain not generated
- Using Railway internal URL instead of public URL
- Domain is behind a firewall

### Solution

**Step 1: Generate public domain in Railway**
1. Railway Dashboard → Your Service
2. Go to **Settings → Networking**
3. Under **Public Networking**, click **Generate Domain**
4. Copy the public URL (should look like `https://audioprocessor-prod.up.railway.app`)

**Step 2: Use that domain in frontend**
1. Frontend → Backend Settings
2. Enter the **public domain** (e.g., `https://audioprocessor-prod.up.railway.app`)
3. **Connect** and verify

**Step 3: Check if domain is DNS-resolvable**
```bash
# From your local machine, run:
nslookup audioprocessor-prod.up.railway.app
# or
ping -c 1 audioprocessor-prod.up.railway.app
```

Should return an IP address, not `NXDOMAIN`.

---

## Complete Verification Workflow

Use this step-by-step workflow to verify everything is working:

### Step 1: Test Backend Health
```bash
curl -v https://YOUR-RAILWAY-URL/health
```
**Expected**: `200 OK` with `{"ok":true,"ffmpeg":true,"ffprobe":true}`

### Step 2: Test CORS Preflight
```bash
curl -X OPTIONS \
  -H "Origin: https://your-app.lovable.app" \
  -H "Access-Control-Request-Method: POST" \
  -v https://YOUR-RAILWAY-URL/analyze
```
**Expected**: `200 OK` with CORS headers

### Step 3: Test File Upload (with small test file)
```bash
# Create a test MP3 (or use an existing one)
# Then create a test ZIP:
zip test.zip test.mp3

curl -X POST \
  -F "file=@test.zip" \
  https://YOUR-RAILWAY-URL/analyze \
  -v
```
**Expected**: `202 Accepted` with `{"jobId":"..."}`

### Step 4: Check Job Status
```bash
curl https://YOUR-RAILWAY-URL/jobs/YOUR-JOB-ID
```
**Expected**: Shows job details with `status: "analyzing"`

### Step 5: Test Frontend Connection
1. Enter backend URL in frontend: `https://YOUR-RAILWAY-URL`
2. Should show ✅ **Connected**
3. Disable Demo Mode
4. Try uploading a test ZIP

---

## Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | HTTP port |
| `HOST` | 0.0.0.0 | Listen address |
| `CORS_ORIGIN` | * | Allowed frontend origins (comma-separated) |
| `MAX_UPLOAD_MB` | 2048 | Max upload size in MB |
| `JOB_RETENTION_MINUTES` | 60 | How long to keep completed jobs |
| `PROCESS_CONCURRENCY` | 2 | Max parallel file processing (reduce if OOM) |
| `JOB_ROOT` | /tmp/voice-batch-jobs | Temp directory for jobs |
| `NODE_ENV` | production | Node environment |

---

## Railroad Deployment-Specific Issues

### Issue: Service keeps restarting
- Check memory usage in logs
- Increase **Memory** in Railway Settings
- Reduce `PROCESS_CONCURRENCY`

### Issue: Railway keeps timing out
- Increase **Build Timeout** in Railway Settings
- Set to at least **15 minutes**

### Issue: Files disappear after download
- Increase `JOB_RETENTION_MINUTES` in Variables
- Set to at least **240** (4 hours)

### Issue: "Dockerfile not found"
- Ensure root directory in Railway is set to `/backend`
- The Dockerfile must be in the root of that directory

---

## Debug Mode: Enable Verbose Logging

### In Railway environment:

1. Add variable: `DEBUG=*` (to enable all debug logs)
2. **Redeploy**
3. Check logs for verbose output

### Clear old jobs on restart:

Add this to `src/jobs.js` if needed:
```javascript
// Clear all old jobs on startup
jobs.clear();
```

---

## Still Having Issues?

### Collect diagnostic info:

1. **Backend health check result** (status code and response)
2. **Browser console errors** (screenshot or paste)
3. **Network tab request/response** (screenshot of failed request)
4. **Railway logs** (last 50 lines when error occurs)
5. **Frontend backend URL entered** (what did you paste?)
6. **CORS_ORIGIN variable in Railway** (what is it set to?)

Then create a GitHub issue with this information.

---

## Quick Fix Command Cheat Sheet

```bash
# Check if backend is reachable
curl https://YOUR-RAILWAY-URL/health -v

# Test file upload (replace with your backend URL)
zip test.zip sample.mp3
curl -X POST -F "file=@test.zip" https://YOUR-RAILWAY-URL/analyze -v

# SSH into Railway container and check files
railway run ls -la /tmp/voice-batch-jobs/

# Restart Railway service
railway down
railway up

# View logs in real-time
railway logs -f

# Check running processes
railway run ps aux | grep ffmpeg
```

---

## Next Steps

Once connection is working:
1. ✅ Verify `/health` endpoint responds
2. ✅ Upload small test ZIP (10 files, 100MB)
3. ✅ Monitor processing in job status
4. ✅ Download and verify output ZIP
5. ✅ Check report CSV
6. ✅ Then try full 300+ file batch
