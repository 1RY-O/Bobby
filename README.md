# Bobby

Bobby is a small helper app for software developers.

When something goes wrong in your code, Bobby acts like a little team of robot helpers. They look at the problem, figure out what is wrong, and suggest a fix. You can watch them work live on a simple dashboard.

## How It Works

Think of Bobby as three helpers working together, one after the other:

1. **Orchestrator - The Planner**
   - This is the boss helper.
   - It makes a plan and decides what needs to be done.
   - Then it passes the work to the next helper.

2. **Investigator - The Detective**
   - This helper looks for clues.
   - It reads error messages and checks the code.
   - Example: "Analyzing stack trace..."

3. **Remediation - The Fixer**
   - This helper fixes the problem.
   - It suggests or applies a small repair.
   - Example: "Applying remediation patch..."

You see all three helpers as boxes on the screen, connected in a line.

## How to Run It

You need two parts running: the backend (the brain) and the frontend (the screen).

**Start the backend:**

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
```

The backend will run at `http://localhost:8000`.

The backend only accepts a few new workflows per minute from the same
computer, so pause for a moment between demo runs.

**Start the frontend:**

Open a new terminal window, then run:

```bash
cd frontend
npm install
npm run dev
```

The app will run at `http://localhost:3000`.

## Tech Stack

These are the main tools used to build Bobby:

- **Next.js** - Builds the website and dashboard you see.
- **FastAPI** - Runs the backend server and handles messages.
- **LangGraph** - Connects the three helpers in a step-by-step workflow.
- **Tailwind CSS** - Styles the static deep-space glass console.
- **CSS animations** - Every glow, fade and hover is plain CSS (no animation library).
- **React Flow** - Shows the helpers as connected boxes.
