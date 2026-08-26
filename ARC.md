Typical KBTU student workflows

check wsp - review attendance (how much skips remaining), check scores, predict GPA (set target), retrieve files (new file/folder notification, organized file-workspace, RAG based on the files, file auto download and straight into RAG, agentic file parsing and context retrieval), check if a course was delayed or cancelled (notifications in MS teams suck)

check teams - if the course was delayed/postponed/changed/cancelled, schedule отрабока занятий, assignment change notification and submission planner, office hours scheduler, file parser, imporant notes retriever.

plan semester - check for opportunities (online through web, telegram, uni outlook: hackathons, internships), review days for midterm-endterm, keep track of course projects (deadlines, requirements, teamwork).

team projects - organize milestones, have shared workspace, excalidraw/trello/jira/linear thing, distribute roles, set objectives, have meetings once per week, update course supervisor on the progression, send office hours request and set the date-time, tracking who does the job and who doesn't.

actual learning - organize materials, retrieve information, present it as cheatsheet, practice quiz/tasks/coding, review examination process and standards, track deadlines, vibecoding projects and labs, doing the documentations and reports, keep track of report formats, memorize key facts/theory/terms/processes, filter primary info from secondary data, research topics on the internet (perplexity, gemini, google search, google scholar), keep different conspects and changelogs, self-organize the time.


Possible agentic tools:
1. Claude Code Chrome Extension alternative, but with gemini - browsing chrome web, doing actions (presentation in Canva, google docs reports, word document reports, power point presentation generation, researching, checking WSP and teams, check selected telegram channels for events/hackathons/internships, communicate with teammates, open HTML/PDF and other documents via local link, check MS teams and write messages)
2. Study prep agent:
i. Syllabus parser and interpretor subagent - understands syllabus, checks the topics, looks for opencourseware and respected YouTube content for preparation (data hub, knowledge hub)
ii. Local coursework methodist subagent - creates fully-local courseware based on uni coursework, suggested resources, books, YouTube open courses, opencoursewares. Uses adapted style for interpretation, serves as chatbot, audiopodcasts, quizzes (like notebookLM, but more adapted and optimized via RAG; or can do it through notebooklm via chrome agent).
3. A personal AI agent tutor that uses RAG and coursework to prep you in a dedicated offline session with dayflow proctoring. Can use Elevenlabs, or build gemini-powered alternative.

Maybe the 1st option could be the best to build in 3-4 days.



Top inputs:
MS Teams
WSP
Telegram chat with diploma project or coursework project teammates

Top outcomes:
Presentations (canva, power-point)
Github repo projects
ipynb notebooks with reports in Kaggle/Colab
docs, pdf reports, research papers

Top jobs:
monitor wsp (attendance to ensure 70% or over by the end of semester to avoid retake and mark the attendance automatically in wsp when the button pops-up, files parsing per course because no notification comes when they are updated, news about local events or course delay/reschedule/cancellations, automatic best-possible cGPA prediction calculator, more comfortable timetable tracking and cabinet location - where to go at the moment because sometimes I can forget that I have a course when I get distracted, would want to get a phone notification), MS teams (course announcements, course files, assignments) - the notifications in MS teams are total bullshit and it works very poorly, do homework (pdf/docs reports - aka changelogs of your actions, vibecoded github repositories and ipynb notebooks for lab projects, doing kaggle/google-scholar/internet research, do canva/power-point presentations, do project works with teammates - do PR in github repo, communicate in telegram, organize via linear, want to connect linear-MCP in someway).