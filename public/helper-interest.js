(() => {
  const form = document.getElementById("helper-interest-form");
  const status = document.getElementById("helper-interest-status");
  if (!form || !status) return;

  const setStatus = (message, tone = "neutral") => {
    status.textContent = message;
    status.className = `text-sm ${tone === "error" ? "text-red-300" : tone === "success" ? "text-green-300" : "text-slate-400"}`;
  };

  const fillFromProfile = async () => {
    try {
      const response = await fetch("/api/me", { headers: { Accept: "application/json" } });
      if (!response.ok) return;
      const data = await response.json();
      const user = data.user || {};
      if (user.name && !form.elements.name.value) form.elements.name.value = user.name;
      if (user.email && !form.elements.email.value) form.elements.email.value = user.email;
      setStatus("Signed-in profile detected. You can edit these details before submitting.");
    } catch {
      // Anonymous visitors can still submit contact details manually.
    }
  };

  fillFromProfile();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button[type='submit']");
    const payload = Object.fromEntries(new FormData(form).entries());
    payload.consent_contact = form.elements.consent_contact.checked;

    try {
      button.disabled = true;
      setStatus("Saving your helper interest…");
      const response = await fetch("/api/helper-interest", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not save helper interest.");
      form.reset();
      setStatus("Thanks — your interest was saved for organizers to review.", "success");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      button.disabled = false;
    }
  });
})();
