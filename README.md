# Online MUN

A real-time Model United Nations committee room in the browser. It has no dependencies; you only need Node 18+.

```bash
npm start            # http://localhost:3000  (PORT=xxxx to change)
```

## How it works
1. **Landing page:** choose **Create Meeting** or **Join Meeting**, or browse past **Meeting records** to view or download them.
2. **Create Meeting:** you become the Chair. Pick **Automatic** setup (committee, topic and 10 countries chosen for you; use *Shuffle* to re-roll) or **Manual** setup (edit everything yourself). Choose how many **AI delegates** to seat; their countries are assigned at random. The server then generates a **meeting code** for you to share.
3. **Join Meeting:** enter the code, then pick a free country from the meeting's participating countries. The creator's browser keeps a host key, so the creator rejoins as Chair on the same device.
4. **Meeting flow:** the Chair moves the committee through the stages:
   1. Conference Setup → 2. Opening Speeches → 3. Motion Raising → 4. Motion Voting → 5. Caucus / Debate → 6. Resolution / Final Vote → 7. Conference Results
   - Delegates raise motions in stage 3, and the Chair puts them to a vote (one vote per country) in stage 4.
   - Delegates submit draft resolutions in stages 5–6, and the Chair puts them to the final vote in stage 6.
   - A motion or resolution passes when votes *for* exceed votes *against*.
5. **End meeting:** the Chair ends the meeting. A record is generated, including delegations, proceedings, motions, resolutions with tallies and the public transcript (private notes are excluded). It's saved to `records/` and can be downloaded as Markdown or JSON.

Other features: a public floor chat, private notes between participants, Chair announcements, a speakers list (raise placard / recognise next) and a copyable meeting code.

## Notes
- Live meetings are kept in memory, so restarting the server ends them. Finished meeting records persist in `records/` (`RECORDS_DIR` overrides the folder).
- Anyone who can reach the server can see the meeting records list.
- AI delegates currently hold seats only. They don't speak or vote yet.
- Refreshing the page keeps your seat. If you close the tab, your seat is released after 15 seconds.
- Real-time updates use Server-Sent Events. API: `POST /api/create`, `/api/join`, `/api/action`; `GET /api/meeting?code=`, `/api/autoconfig`, `/api/records`, `/api/records/:id`, `/api/records/:id/download?format=md|json`.
