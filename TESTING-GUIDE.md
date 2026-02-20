# Signup Form Testing Guide

Quick reference for testing the Hack the Valley signup form.

## Quick Start

### 1. Start Dev Server
```bash
cd ~/palmer/workspace/hack-the-valley
npx wrangler pages dev public --port 8788
```

### 2. Access Locally
**URL:** http://localhost:8788/#signup

### 3. Enable Remote Access
```bash
tailscale serve --bg --https=8789 http://localhost:8788
```

**Remote URL:** https://skylars-mac-mini.taile4d789.ts.net:8789/#signup

## Test Cases

### ✅ Test 1: Required Field Validation
1. Go to signup form
2. Click "Register for Hack the Valley" without filling anything
3. **Expected:** Red error messages appear for all required fields:
   - Full Name
   - Email
   - University/School
   - Year in School
   - **Coding Experience Level** ← NEW FIELD
   - T-Shirt Size
   - Code of Conduct checkbox

### ✅ Test 2: Email Validation
1. Fill all required fields
2. Enter invalid email: `notanemail`
3. Click submit
4. **Expected:** "Please enter a valid email address" error

### ✅ Test 3: Successful Submission
1. Fill all required fields with valid data:
   - Name: Test Student
   - Email: test@example.com
   - University: CSUB
   - Year: Junior
   - Major: Computer Science (optional)
   - **Experience: Intermediate** ← NEW
   - Dietary: Vegetarian (optional)
   - T-Shirt: M
   - [x] Code of Conduct
2. Click submit
3. **Expected:**
   - Button shows "Submitting..."
   - Green success message appears
   - Form resets to blank

### ✅ Test 4: Backend Processing
Check wrangler dev server console output:
```
registration_backup_record {
  "name": "Test Student",
  "email": "test@example.com",
  "experience": "intermediate",  ← Should be present
  ...
}
```

### ✅ Test 5: Experience Level Options
1. Click "Coding Experience Level" dropdown
2. **Expected options:**
   - Select... (default, blank)
   - Beginner (Just getting started)
   - Intermediate (Built some projects)
   - Advanced (Experienced developer)

## Sample Test Data

**Complete valid form:**
```
Full Name: Alex Chen
Email: alex.chen@csub.edu
University: California State University, Bakersfield
Year: Junior
Major: Computer Science
Experience Level: Intermediate
Dietary: None
T-Shirt: M
[x] Code of Conduct
```

**Minimal valid form (only required):**
```
Full Name: Sam Lee
Email: sam@example.com
University: CSUB
Year: Sophomore
Experience Level: Beginner
T-Shirt: L
[x] Code of Conduct
```

## Expected Backend Response

### Success (200 OK)
```json
{
  "success": true,
  "deliveredByEmail": false,
  "message": "Registration received"
}
```

### Validation Error (400)
```json
{
  "error": "Missing required fields"
}
```

### Server Error (500)
```json
{
  "error": "Internal server error"
}
```

## Monitoring Logs

### View real-time logs:
```bash
# Terminal where wrangler is running shows all logs
# Look for:
# - "POST /api/register 200 OK" (success)
# - "registration_backup_record" (data logged)
# - Any error messages
```

### Check for experience field in logs:
```bash
# Should see in backup record:
"experience": "beginner" | "intermediate" | "advanced"
```

## Common Issues

### Form won't submit
- **Cause:** Missing required field
- **Fix:** Check all fields marked with `*`

### "Mail send failed: 401"
- **Cause:** Expected in dev (no MailChannels API key)
- **Fix:** None needed - backup logging captures data
- **Note:** Will work in production with env vars set

### Experience field not in logs
- **Cause:** Old code cached
- **Fix:** Hard reload (Cmd+Shift+R) and restart server

### Validation not working
- **Cause:** JavaScript error
- **Fix:** Check browser console (F12) for errors

## Browser Testing

### Chrome/Edge
```bash
open -a "Google Chrome" http://localhost:8788/#signup
```

### Safari
```bash
open -a Safari http://localhost:8788/#signup
```

### Firefox
```bash
open -a Firefox http://localhost:8788/#signup
```

## Production Testing

Once deployed to Cloudflare Pages:

1. Go to production URL
2. Test form submission
3. Check that emails are delivered (if env vars configured)
4. Verify no console errors in browser

## Cleanup

### Stop dev server:
```bash
# Ctrl+C in terminal running wrangler
# OR
kill $(ps aux | grep 'wrangler.*8788' | grep -v grep | awk '{print $2}')
```

### Stop Tailscale serve:
```bash
tailscale serve --https=8789 off
```

## Automated Testing (Future)

Consider adding:
```javascript
// test/signup.test.js
describe('Signup Form', () => {
  it('validates required fields', () => {
    // Test validation logic
  });
  
  it('accepts valid experience levels', () => {
    // Test experience field options
  });
  
  it('submits form successfully', () => {
    // Test API integration
  });
});
```

## Quick Verification Checklist

- [ ] Dev server starts without errors
- [ ] Form loads at `/#signup` anchor
- [ ] All 9 form fields visible (including experience)
- [ ] Experience dropdown has 3 options + blank
- [ ] Required field validation triggers
- [ ] Email validation works
- [ ] Successful submission shows green message
- [ ] Backend logs show experience field
- [ ] Form resets after submission
- [ ] Tailscale URL accessible remotely

---

**Last Updated:** 2026-02-19  
**Test Status:** ✅ All tests passing
