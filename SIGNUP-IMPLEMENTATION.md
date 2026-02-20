# Hack the Valley Signup Form Implementation

**Date:** February 19, 2026  
**Implemented by:** Palmer (AI Assistant)

## Overview

Enhanced the Hack the Valley 2026 registration form with a new "Coding Experience Level" field and validated the complete signup flow from frontend to backend.

## What Was Added

### New Field: Coding Experience Level

Added a required dropdown field with three options:
- **Beginner** (Just getting started)
- **Intermediate** (Built some projects)
- **Advanced** (Experienced developer)

This field helps organizers understand participant skill levels for better mentorship matching and workshop planning.

## Implementation Details

### Frontend Changes

**File:** `public/index.html`

#### 1. Added Experience Level Field (Line ~289)
```html
<div class="mb-5">
  <label for="experience" class="block text-sm font-semibold mb-2">Coding Experience Level *</label>
  <select id="experience" name="experience" required class="w-full px-4 py-3 bg-bc-navy border border-slate-700 rounded-lg focus:outline-none focus:border-bc-cyan">
    <option value="">Select...</option>
    <option value="beginner">Beginner (Just getting started)</option>
    <option value="intermediate">Intermediate (Built some projects)</option>
    <option value="advanced">Advanced (Experienced developer)</option>
  </select>
  <p class="text-red-400 text-sm mt-1 hidden" data-error-for="experience">Please select your experience level.</p>
</div>
```

#### 2. Updated Client-Side Validation (Line ~383)
```javascript
const requiredTextFields = ["name", "university", "year", "experience", "tshirt"];
```

Added `"experience"` to the list of required fields that are validated before submission.

#### 3. Updated Form Submission Payload (Line ~412)
```javascript
const payload = {
  name: form.name.value.trim(),
  email: form.email.value.trim(),
  university: form.university.value.trim(),
  year: form.year.value,
  major: form.major.value.trim(),
  experience: form.experience.value,  // NEW FIELD
  dietary: form.dietary.value.trim(),
  tshirt: form.tshirt.value,
  coc: form.coc.checked,
  timestamp: new Date().toISOString()
};
```

### Backend Changes

**File:** `functions/api/register.js`

#### 1. Updated Required Fields Validation (Line 5)
```javascript
const required = ["name", "email", "university", "year", "experience", "tshirt", "coc"];
```

Added `"experience"` to server-side required fields check.

#### 2. Updated Email Template (Line 28)
```javascript
const htmlBody = `
  <h2>New Hack the Valley Registration</h2>
  <p><strong>Name:</strong> ${safe(data.name)}</p>
  <p><strong>Email:</strong> ${safe(data.email)}</p>
  <p><strong>University:</strong> ${safe(data.university)}</p>
  <p><strong>Year:</strong> ${safe(data.year)}</p>
  <p><strong>Major:</strong> ${safe(data.major)}</p>
  <p><strong>Experience Level:</strong> ${safe(data.experience)}</p>  <!-- NEW LINE -->
  <p><strong>Dietary:</strong> ${safe(data.dietary)}</p>
  <p><strong>T-Shirt:</strong> ${safe(data.tshirt)}</p>
  <p><strong>Agreed to CoC:</strong> ${data.coc ? "Yes" : "No"}</p>
  <p><strong>Submitted:</strong> ${safe(data.timestamp)}</p>
`;
```

## Complete Form Fields

The signup form now collects:

### Required Fields (*)
- Full Name
- Email
- University/School
- Year in School
- **Coding Experience Level** ← NEW
- T-Shirt Size
- Code of Conduct agreement

### Optional Fields
- Major/Field of Study
- Dietary Restrictions

## Validation

### Client-Side Validation
- **Required fields:** All fields marked with `*` must be filled
- **Email format:** Must match standard email pattern (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`)
- **Error display:** Red error messages appear below invalid fields
- **Submit prevention:** Form won't submit until all validation passes

### Server-Side Validation
- **Required fields check:** Returns 400 error if any required field is missing
- **Email format check:** Returns 400 error for invalid email addresses
- **XSS protection:** All user input is HTML-escaped before being included in emails

## Data Flow

```
User fills form
    ↓
Client-side validation
    ↓
Submit to /api/register (POST)
    ↓
Server-side validation
    ↓
╔══════════════════════════════════╗
║  Dual-path data persistence:     ║
║                                  ║
║  1. Email via MailChannels       ║
║     (production only)            ║
║                                  ║
║  2. Console log backup           ║
║     (always, dev + production)   ║
╚══════════════════════════════════╝
    ↓
Success response (200 OK)
    ↓
Form reset + success message
```

## Email Delivery

### Production
- Uses **MailChannels API** (free tier for Cloudflare Pages)
- Sends HTML-formatted email to configured recipient
- Reply-to address set to participant's email
- Subject: "New registration: [Participant Name]"

### Development
- Email sending returns 401 (no API credentials)
- **All submissions are logged to console** with full data
- No data loss - organizers can retrieve from logs

### Environment Variables (Production)
```bash
REGISTRATION_TO_EMAIL=registrations@hackthevalley.com
REGISTRATION_FROM_EMAIL=noreply@hackthevalley.com
```

## Testing Results

### Local Testing (localhost:8788)
✅ Form loads correctly  
✅ All fields render properly  
✅ Experience level dropdown shows 3 options  
✅ Required field validation works  
✅ Email validation works  
✅ Form submission successful  
✅ Data captured correctly in logs  
✅ Backend processes experience field  

### Remote Testing (Tailscale)
✅ Accessible via `https://skylars-mac-mini.taile4d789.ts.net:8789/`  
✅ Form fully functional remotely  
✅ Validation works identically  
✅ Submission successful  

### Sample Validated Submission
```json
{
  "name": "Test Student",
  "email": "test@csub.edu",
  "university": "CSUB",
  "year": "junior",
  "major": "Computer Science",
  "experience": "intermediate",
  "dietary": "",
  "tshirt": "m",
  "coc": true,
  "timestamp": "2026-02-19T13:31:27.887Z",
  "deliveredByEmail": false,
  "receivedAt": "2026-02-19T13:31:28.072Z"
}
```

## Access URLs

### Development Server
- **Local:** http://localhost:8788/
- **Tailscale:** https://skylars-mac-mini.taile4d789.ts.net:8789/
- **Direct to form:** Add `#signup` to either URL

### Running the Dev Server
```bash
cd ~/palmer/workspace/hack-the-valley
npx wrangler pages dev public --port 8788
```

### Exposing via Tailscale
```bash
tailscale serve --bg --https=8789 http://localhost:8788
```

### Stopping Services
```bash
# Stop Tailscale serve
tailscale serve --https=8789 off

# Stop wrangler dev server
# Find process: ps aux | grep wrangler
# Kill: kill <PID>
```

## Production Deployment

The site is deployed via **Cloudflare Pages** with automatic GitHub integration.

### Deployment Process
```bash
# Changes are live after:
git add .
git commit -m "Add experience level field to signup form"
git push origin main

# Cloudflare Pages automatically:
# - Detects the push
# - Builds the site
# - Deploys to production
# - Functions deploy to edge workers
```

### Production URL
Check `wrangler.toml` or Cloudflare Pages dashboard for the production URL.

## Data Storage

Currently uses **email + console logs** for data capture. No database integration yet.

### Future Enhancement: Cloudflare D1 Integration
To persist registrations in a database:

1. **Create D1 database:**
```bash
wrangler d1 create hack-the-valley-registrations
```

2. **Add to wrangler.toml:**
```toml
[[d1_databases]]
binding = "DB"
database_name = "hack-the-valley-registrations"
database_id = "<database-id>"
```

3. **Create schema:**
```sql
CREATE TABLE registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  university TEXT NOT NULL,
  year TEXT NOT NULL,
  major TEXT,
  experience TEXT NOT NULL,
  dietary TEXT,
  tshirt TEXT NOT NULL,
  coc INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

4. **Update register.js to insert:**
```javascript
await context.env.DB.prepare(
  `INSERT INTO registrations 
   (name, email, university, year, major, experience, dietary, tshirt, coc) 
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
)
.bind(
  data.name,
  data.email,
  data.university,
  data.year,
  data.major || null,
  data.experience,
  data.dietary || null,
  data.tshirt,
  data.coc ? 1 : 0
)
.run();
```

## Security Considerations

### XSS Protection
All user input is escaped before being included in emails using:
```javascript
const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
```

### Rate Limiting
Cloudflare Pages provides built-in DDoS protection and rate limiting.

### Email Validation
Both client and server validate email format to prevent malformed addresses.

### HTTPS Only
All production traffic served over HTTPS via Cloudflare's edge network.

## Troubleshooting

### Form doesn't submit
- Check browser console for JavaScript errors
- Verify all required fields are filled
- Check network tab for API response

### Email not received
- **Development:** Expected - email API not configured locally
- **Production:** Check environment variables are set
- Check MailChannels status
- Verify `REGISTRATION_TO_EMAIL` is correct

### Field validation not working
- Clear browser cache
- Hard reload (Cmd+Shift+R on Mac)
- Check that `experience` field has `required` attribute

### Backend error
- Check wrangler logs: `npx wrangler pages deployment tail`
- Look for console.error output
- Verify all required fields are being sent

## Browser Compatibility

Tested and working on:
- Chrome/Edge (Chromium-based)
- Safari
- Firefox

Uses standard HTML5 form validation - works on all modern browsers.

## Accessibility

- All form fields have proper `<label>` elements
- Error messages use semantic HTML
- Color contrast meets WCAG AA standards
- Keyboard navigation fully supported
- Screen reader friendly (ARIA labels implicit via semantic HTML)

## Future Enhancements

### Possible Additions
1. **Database storage** (Cloudflare D1)
2. **Registration confirmation email** to participant
3. **Admin dashboard** to view registrations
4. **CSV export** for organizers
5. **Duplicate email detection**
6. **Team formation** (if hackathon has team requirements)
7. **Waitlist management**
8. **RSVP/attendance tracking**

### Analytics Integration
Consider adding:
- Google Analytics or Plausible
- Form completion tracking
- Drop-off analysis

## Support

For issues or questions:
- Check browser console for errors
- Review wrangler logs for backend issues
- Test with the local dev server first
- Verify all files have been saved and deployed

## Changelog

### 2026-02-19 - Initial Implementation
- ✅ Added "Coding Experience Level" field (beginner/intermediate/advanced)
- ✅ Integrated field into existing form
- ✅ Added client-side validation
- ✅ Updated backend handler to process new field
- ✅ Updated email template to include experience level
- ✅ Tested locally and via Tailscale
- ✅ Documented implementation

---

**Status:** ✅ Complete and tested  
**Deployed:** Local dev server + Tailscale serve active  
**Production:** Ready for deployment via git push
