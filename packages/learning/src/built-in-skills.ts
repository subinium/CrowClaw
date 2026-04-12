import type { StoredSkillDraft, SkillStore } from './index.js';

const BUILT_IN_SKILLS: Omit<StoredSkillDraft, 'id' | 'createdAt' | 'updatedAt'>[] = [
  {
    slug: 'git-commit-workflow',
    title: 'Git Commit Workflow',
    summary: 'Standard git workflow: stage changes, write conventional commit message, push.',
    triggerPhrases: ['commit changes', 'git commit', 'push changes', 'commit and push'],
    steps: [
      'Check git status for uncommitted changes',
      'Stage relevant files with git add',
      'Write conventional commit message (feat/fix/refactor/docs/chore)',
      'Create commit',
      'Push to remote'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Git Commit Workflow\n\nStandard git workflow for committing and pushing changes.'
  },
  {
    slug: 'code-review',
    title: 'Code Review',
    summary: 'Review code changes for security, correctness, performance, and style issues.',
    triggerPhrases: ['review code', 'code review', 'review PR', 'review changes', 'check my code'],
    steps: [
      'Read the diff or changed files',
      'Check for security vulnerabilities (injection, auth bypass, secret exposure)',
      'Verify correctness of logic and error handling',
      'Check for performance issues (N+1 queries, unnecessary re-renders)',
      'Review types and type safety',
      'Check test coverage',
      'Report findings with severity classification'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Code Review\n\nSystematic code review process.'
  },
  {
    slug: 'debug-error',
    title: 'Debug Error',
    summary: 'Systematic approach to debugging: read error, trace data flow, form hypothesis, verify.',
    triggerPhrases: ['debug this', 'fix this error', 'why is this failing', 'investigate bug', 'troubleshoot'],
    steps: [
      'Read the full error message and stack trace',
      'Identify the error source file and line number',
      'Trace the data flow to understand context',
      'Form a single hypothesis',
      'Make the smallest change to verify',
      'If fixed, verify with the same test that failed',
      'If not fixed, revise hypothesis and repeat'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Debug Error\n\nSystematic debugging approach.'
  },
  {
    slug: 'project-setup-nextjs',
    title: 'Next.js Project Setup',
    summary: 'Set up a new Next.js project with TypeScript, Tailwind CSS, and common configurations.',
    triggerPhrases: ['create next app', 'setup nextjs', 'new next project', 'start nextjs project'],
    steps: [
      'Run npx create-next-app@latest with TypeScript',
      'Configure Tailwind CSS',
      'Set up ESLint and Prettier',
      'Create directory structure (components, lib, types)',
      'Configure environment variables',
      'Initialize git repository'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Next.js Project Setup\n\nQuickstart for new Next.js projects.'
  },
  {
    slug: 'api-endpoint',
    title: 'Create API Endpoint',
    summary: 'Create a new REST API endpoint with validation, error handling, and types.',
    triggerPhrases: ['create api endpoint', 'add api route', 'new endpoint', 'build api'],
    steps: [
      'Define request/response types',
      'Create route handler file',
      'Add input validation',
      'Implement business logic',
      'Add error handling with structured responses',
      'Write tests for the endpoint'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Create API Endpoint\n\nStandard pattern for REST API endpoints.'
  },
  {
    slug: 'database-migration',
    title: 'Database Migration',
    summary: 'Create and run a database migration safely with rollback plan.',
    triggerPhrases: ['create migration', 'database migration', 'alter table', 'add column', 'schema change'],
    steps: [
      'Design the schema change',
      'Create migration file with up and down functions',
      'Test migration locally',
      'Review for data safety (no data loss, backward compatibility)',
      'Run migration',
      'Verify data integrity'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Database Migration\n\nSafe database migration workflow.'
  },
  {
    slug: 'deploy-vercel',
    title: 'Deploy to Vercel',
    summary: 'Deploy a web application to Vercel with environment configuration.',
    triggerPhrases: ['deploy to vercel', 'vercel deploy', 'ship to production', 'deploy website'],
    steps: [
      'Verify build passes locally',
      'Check environment variables are configured',
      'Ensure .vercelignore excludes large files',
      'Run vercel deploy --prod',
      'Verify deployment URL is accessible',
      'Check logs for any errors'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Deploy to Vercel\n\nVercel deployment checklist.'
  },
  {
    slug: 'write-tests',
    title: 'Write Tests',
    summary: 'Write unit and integration tests for a feature or fix.',
    triggerPhrases: ['write tests', 'add tests', 'test this', 'need tests', 'create test'],
    steps: [
      'Identify the code to test',
      'Determine test type (unit, integration, e2e)',
      'Write happy path tests first',
      'Add edge case tests',
      'Add error/failure tests',
      'Run tests and verify they pass',
      'Check coverage'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Write Tests\n\nSystematic test writing approach.'
  },
  {
    slug: 'refactor-module',
    title: 'Refactor Module',
    summary: 'Safely refactor code: ensure tests exist, make changes, verify nothing breaks.',
    triggerPhrases: ['refactor this', 'clean up code', 'restructure', 'improve code quality'],
    steps: [
      'Read and understand the current code',
      'Ensure test coverage exists (write tests if not)',
      'Identify the refactoring goals',
      'Make small, incremental changes',
      'Run tests after each change',
      'Verify no behavior changes (unless intended)'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Refactor Module\n\nSafe refactoring workflow.'
  },
  {
    slug: 'docker-setup',
    title: 'Docker Setup',
    summary: 'Create Dockerfile and docker-compose for a project.',
    triggerPhrases: ['dockerize', 'create dockerfile', 'docker setup', 'containerize'],
    steps: [
      'Choose appropriate base image',
      'Create Dockerfile with multi-stage build',
      'Create .dockerignore',
      'Create docker-compose.yml if needed',
      'Build and test locally',
      'Document environment variables'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Docker Setup\n\nDockerization workflow.'
  },
  {
    slug: 'security-audit',
    title: 'Security Audit',
    summary: 'Audit code for common security vulnerabilities and fix them.',
    triggerPhrases: ['security audit', 'check security', 'find vulnerabilities', 'security review'],
    steps: [
      'Check for injection vulnerabilities (SQL, XSS, command)',
      'Review authentication and authorization',
      'Check for secret exposure in code/logs',
      'Verify CORS configuration',
      'Check dependency vulnerabilities (npm audit)',
      'Review error handling (no stack traces in production)',
      'Report findings with severity'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Security Audit\n\nSecurity review checklist.'
  },
  {
    slug: 'performance-optimization',
    title: 'Performance Optimization',
    summary: 'Profile and optimize application performance.',
    triggerPhrases: ['optimize performance', 'make it faster', 'performance issue', 'slow query', 'why is this slow'],
    steps: [
      'Identify the bottleneck (measure, don\'t guess)',
      'Profile the specific area (queries, rendering, network)',
      'Check for N+1 queries',
      'Check bundle size impact',
      'Implement the optimization',
      'Measure the improvement',
      'Verify no regressions'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Performance Optimization\n\nPerformance analysis workflow.'
  },
  {
    slug: 'web-scraping',
    title: 'Web Scraping',
    summary: 'Extract data from web pages using fetch and HTML parsing.',
    triggerPhrases: ['scrape website', 'extract data from web', 'web scraping', 'crawl pages'],
    steps: [
      'Identify the target URL and data to extract',
      'Fetch the page content',
      'Parse HTML to find relevant elements',
      'Extract structured data',
      'Handle pagination if needed',
      'Save/return results'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Web Scraping\n\nWeb data extraction workflow.'
  },
  {
    slug: 'github-pr-workflow',
    title: 'GitHub PR Workflow',
    summary: 'Create a GitHub pull request with proper description and checks.',
    triggerPhrases: ['create PR', 'open pull request', 'submit PR', 'make a PR'],
    steps: [
      'Check git status and verify all changes are committed',
      'Push branch to remote',
      'Write PR title (under 72 chars, descriptive)',
      'Write PR description with summary, test plan, and checklist',
      'Create PR using gh CLI',
      'Request reviewers if applicable'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# GitHub PR Workflow\n\nPull request creation workflow.'
  },
  {
    slug: 'env-setup',
    title: 'Environment Setup',
    summary: 'Set up development environment with proper configuration.',
    triggerPhrases: ['setup environment', 'configure env', 'dev setup', 'development environment'],
    steps: [
      'Check runtime versions (Node, Python, etc.)',
      'Install dependencies',
      'Create .env from .env.example',
      'Configure database connections',
      'Run initial migrations',
      'Verify with smoke test'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Environment Setup\n\nDevelopment environment configuration.'
  },

  // ── Apple / macOS ───────────────────────────────────────────────────

  {
    slug: 'apple-notes',
    title: 'Apple Notes',
    summary: 'Create, search, and read Apple Notes using osascript.',
    triggerPhrases: ['create apple note', 'search notes', 'read apple notes', 'add note to apple notes'],
    steps: [
      'Determine the target folder in Apple Notes (default or user-specified)',
      'Construct the osascript/JXA command for the operation (create, search, or read)',
      'Execute the script via osascript and capture output',
      'Parse and format the returned note content',
      'Report results or confirm note creation'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Apple Notes\n\nInteract with Apple Notes via osascript/JXA to create, search, and read notes.'
  },
  {
    slug: 'apple-reminders',
    title: 'Apple Reminders',
    summary: 'Create and list Apple Reminders via osascript.',
    triggerPhrases: ['create reminder', 'add reminder', 'list reminders', 'show my reminders'],
    steps: [
      'Identify the target reminders list (default or user-specified)',
      'Parse the reminder title, due date, and priority from user input',
      'Construct osascript/JXA command to create or list reminders',
      'Execute the script and capture output',
      'Format and display the results'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Apple Reminders\n\nCreate and list Apple Reminders using osascript.'
  },
  {
    slug: 'apple-findmy',
    title: 'Apple Find My',
    summary: 'Check Find My device locations via macOS APIs.',
    triggerPhrases: ['find my devices', 'where is my iphone', 'device locations', 'find my mac'],
    steps: [
      'Access the Find My cache data on macOS',
      'Parse device location records from the local cache files',
      'Extract device name, latitude, longitude, and last-seen timestamp',
      'Format location data into a readable summary',
      'Report device locations and last-updated times'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Apple Find My\n\nCheck Find My device locations using macOS local cache data.'
  },
  {
    slug: 'apple-imessage',
    title: 'Apple iMessage',
    summary: 'Send iMessage messages via osascript.',
    triggerPhrases: ['send imessage', 'send message', 'text someone', 'imessage this'],
    steps: [
      'Identify the recipient phone number or email',
      'Compose the message content',
      'Construct osascript command targeting Messages.app',
      'Execute the send command',
      'Confirm message delivery status'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Apple iMessage\n\nSend iMessage messages programmatically via osascript.'
  },
  {
    slug: 'apple-calendar',
    title: 'Apple Calendar',
    summary: 'Create and query calendar events via osascript.',
    triggerPhrases: ['create calendar event', 'check my calendar', 'add event', 'show calendar events'],
    steps: [
      'Identify the target calendar (default or user-specified)',
      'Parse event details: title, date/time, duration, location',
      'Construct osascript/JXA command for create or query operation',
      'Execute the script and capture output',
      'Format and display event details or confirm creation'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Apple Calendar\n\nCreate and query Apple Calendar events using osascript.'
  },

  // ── GitHub ──────────────────────────────────────────────────────────

  {
    slug: 'github-issue-create',
    title: 'Create GitHub Issue',
    summary: 'Create GitHub issues with proper title, description, and labels.',
    triggerPhrases: ['create issue', 'open github issue', 'file a bug', 'report issue'],
    steps: [
      'Determine the target repository',
      'Write a clear, concise issue title',
      'Write a detailed description with reproduction steps (for bugs) or acceptance criteria (for features)',
      'Select appropriate labels (bug, enhancement, documentation, etc.)',
      'Create the issue using gh CLI',
      'Return the issue URL'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Create GitHub Issue\n\nCreate well-structured GitHub issues with proper labels and descriptions.'
  },
  {
    slug: 'github-pr-review',
    title: 'GitHub PR Review',
    summary: 'Review pull request diffs systematically for correctness and quality.',
    triggerPhrases: ['review this PR', 'review pull request', 'PR review', 'check this pull request'],
    steps: [
      'Fetch the PR diff using gh CLI',
      'Read the PR description and linked issues',
      'Check for security vulnerabilities in changed code',
      'Verify correctness of logic and edge case handling',
      'Check for proper error handling and type safety',
      'Review test coverage for new code paths',
      'Leave review comments with severity classification',
      'Submit review (approve, request changes, or comment)'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# GitHub PR Review\n\nSystematic pull request review workflow.'
  },
  {
    slug: 'github-repo-setup',
    title: 'GitHub Repo Setup',
    summary: 'Initialize a GitHub repository with license, CI, README, and branch protection.',
    triggerPhrases: ['setup github repo', 'initialize repository', 'create new repo', 'setup repo'],
    steps: [
      'Create the repository on GitHub using gh CLI',
      'Add appropriate LICENSE file',
      'Create README.md with project description and setup instructions',
      'Add .gitignore for the project language/framework',
      'Create CI workflow file (.github/workflows/ci.yml)',
      'Configure branch protection rules for main branch',
      'Push initial commit'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# GitHub Repo Setup\n\nFull repository initialization with license, CI, and README.'
  },
  {
    slug: 'github-release',
    title: 'GitHub Release',
    summary: 'Create a GitHub release with changelog and version tags.',
    triggerPhrases: ['create release', 'github release', 'tag release', 'publish release'],
    steps: [
      'Determine the new version number (semver)',
      'Generate changelog from commits since last tag',
      'Update version in package.json/Cargo.toml',
      'Create git tag for the new version',
      'Push tag to remote',
      'Create GitHub release using gh CLI with changelog as body',
      'Verify release artifacts are attached'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# GitHub Release\n\nCreate a versioned GitHub release with auto-generated changelog.'
  },
  {
    slug: 'github-actions-debug',
    title: 'Debug GitHub Actions',
    summary: 'Debug failing GitHub Actions workflows by analyzing logs and configuration.',
    triggerPhrases: ['debug github actions', 'CI is failing', 'workflow failed', 'fix github actions', 'actions not working'],
    steps: [
      'Identify the failing workflow run using gh CLI',
      'Download and read the workflow logs',
      'Identify the specific failing step and error message',
      'Check the workflow YAML for configuration issues',
      'Compare environment/secrets/permissions requirements',
      'Apply the fix to the workflow file',
      'Push and verify the workflow passes'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Debug GitHub Actions\n\nSystematic approach to debugging failing CI/CD workflows.'
  },

  // ── Creative ────────────────────────────────────────────────────────

  {
    slug: 'ascii-art',
    title: 'ASCII Art',
    summary: 'Generate ASCII art text banners and simple graphics.',
    triggerPhrases: ['make ascii art', 'ascii banner', 'text art', 'generate ascii'],
    steps: [
      'Determine the text or image concept to render',
      'Choose an appropriate font/style (block, slant, banner, etc.)',
      'Generate the ASCII art character grid',
      'Adjust spacing and alignment for readability',
      'Output the final ASCII art'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# ASCII Art\n\nGenerate ASCII art banners and simple text graphics.'
  },
  {
    slug: 'svg-diagram',
    title: 'SVG Diagram',
    summary: 'Create SVG diagrams, flowcharts, and illustrations.',
    triggerPhrases: ['create svg', 'draw diagram', 'make svg diagram', 'svg flowchart', 'create illustration'],
    steps: [
      'Understand the diagram requirements (nodes, connections, layout)',
      'Design the layout with proper spacing and alignment',
      'Write SVG markup with shapes, text, and connecting lines',
      'Add colors, fonts, and styling for clarity',
      'Validate SVG syntax and save to file',
      'Preview and adjust dimensions if needed'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# SVG Diagram\n\nCreate SVG diagrams and flowcharts from scratch.'
  },
  {
    slug: 'mermaid-diagram',
    title: 'Mermaid Diagram',
    summary: 'Create Mermaid diagram syntax for flowcharts, sequences, and ERDs.',
    triggerPhrases: ['create mermaid diagram', 'mermaid flowchart', 'sequence diagram', 'mermaid chart', 'entity relationship diagram'],
    steps: [
      'Determine the diagram type (flowchart, sequence, class, ER, gantt, etc.)',
      'Identify the entities, nodes, and relationships',
      'Write Mermaid syntax with proper node definitions',
      'Add connections, labels, and styling directives',
      'Validate the syntax renders correctly',
      'Embed in markdown or HTML as needed'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Mermaid Diagram\n\nCreate Mermaid diagram syntax for various diagram types.'
  },
  {
    slug: 'html-prototype',
    title: 'HTML Prototype',
    summary: 'Create rapid HTML/CSS prototypes for UI concepts.',
    triggerPhrases: ['create html prototype', 'quick html mockup', 'prototype ui', 'html sketch', 'rapid prototype'],
    steps: [
      'Clarify the UI concept and key interactions',
      'Create a single-file HTML document with embedded CSS',
      'Build the layout structure with semantic HTML',
      'Add styling with CSS (flexbox/grid layout, colors, typography)',
      'Add basic interactivity with vanilla JS if needed',
      'Save and provide instructions to open in browser'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# HTML Prototype\n\nRapid single-file HTML/CSS prototyping for UI concepts.'
  },
  {
    slug: 'markdown-presentation',
    title: 'Markdown Presentation',
    summary: 'Create slide decks using markdown syntax.',
    triggerPhrases: ['create presentation', 'make slides', 'markdown slides', 'slide deck', 'create deck'],
    steps: [
      'Determine the presentation topic and target audience',
      'Outline the slide structure (title, sections, conclusion)',
      'Write each slide with concise content and speaker notes',
      'Add code blocks, diagrams, or images where relevant',
      'Format with slide separators (--- for most tools)',
      'Specify the rendering tool (Marp, Slidev, reveal.js) and configuration'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Markdown Presentation\n\nCreate slide decks using markdown-based presentation tools.'
  },

  // ── Data Science / ML ──────────────────────────────────────────────

  {
    slug: 'jupyter-notebook',
    title: 'Jupyter Notebook',
    summary: 'Create and edit Jupyter notebooks with code cells and markdown.',
    triggerPhrases: ['create notebook', 'jupyter notebook', 'make ipynb', 'create jupyter'],
    steps: [
      'Determine the notebook purpose and required libraries',
      'Create the .ipynb file with proper JSON structure',
      'Add markdown cells for documentation and section headers',
      'Write code cells with imports, data loading, and analysis',
      'Add output cells with expected results or visualizations',
      'Verify the notebook structure is valid JSON'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Jupyter Notebook\n\nCreate and edit Jupyter notebooks programmatically.'
  },
  {
    slug: 'data-analysis',
    title: 'Data Analysis',
    summary: 'Analyze CSV/JSON datasets with summary statistics and insights.',
    triggerPhrases: ['analyze data', 'data analysis', 'analyze csv', 'explore dataset', 'data summary'],
    steps: [
      'Load and inspect the data file (CSV, JSON, etc.)',
      'Check data shape, types, and missing values',
      'Compute summary statistics (mean, median, std, quartiles)',
      'Identify outliers and data quality issues',
      'Find correlations and patterns in the data',
      'Generate a structured summary with key findings'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Data Analysis\n\nAnalyze datasets with summary statistics and insights.'
  },
  {
    slug: 'visualization',
    title: 'Data Visualization',
    summary: 'Create data visualizations using charting libraries or SVG.',
    triggerPhrases: ['create chart', 'visualize data', 'make a graph', 'data visualization', 'plot data'],
    steps: [
      'Understand the data and the story to tell',
      'Choose the appropriate chart type (bar, line, scatter, pie, heatmap)',
      'Select the visualization library (D3, Chart.js, matplotlib, or raw SVG)',
      'Write the chart code with proper axes, labels, and legends',
      'Apply color scheme and styling for readability',
      'Export or render the visualization'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Data Visualization\n\nCreate charts and graphs from data using various libraries.'
  },
  {
    slug: 'model-evaluation',
    title: 'ML Model Evaluation',
    summary: 'Evaluate machine learning model performance with standard metrics.',
    triggerPhrases: ['evaluate model', 'model metrics', 'model performance', 'check accuracy', 'confusion matrix'],
    steps: [
      'Load model predictions and ground truth labels',
      'Compute classification metrics (accuracy, precision, recall, F1) or regression metrics (MSE, MAE, R2)',
      'Generate confusion matrix for classification tasks',
      'Plot ROC/AUC curves if applicable',
      'Analyze per-class performance and failure modes',
      'Summarize findings with recommendations for improvement'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# ML Model Evaluation\n\nEvaluate ML model performance with standard metrics and visualizations.'
  },

  // ── DevOps / Infrastructure ────────────────────────────────────────

  {
    slug: 'nginx-config',
    title: 'Nginx Configuration',
    summary: 'Create and modify nginx server configurations.',
    triggerPhrases: ['configure nginx', 'nginx config', 'setup nginx', 'nginx reverse proxy', 'nginx ssl'],
    steps: [
      'Determine the server purpose (static files, reverse proxy, load balancer)',
      'Write the server block with listen directives and server_name',
      'Configure location blocks for routing',
      'Add SSL/TLS configuration if needed (certificates, protocols)',
      'Set up proxy_pass for upstream services if applicable',
      'Test configuration with nginx -t',
      'Reload nginx to apply changes'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Nginx Configuration\n\nCreate and modify nginx configurations for various use cases.'
  },
  {
    slug: 'systemd-service',
    title: 'Systemd Service',
    summary: 'Create systemd service unit files for background processes.',
    triggerPhrases: ['create systemd service', 'systemd unit', 'make service file', 'run as daemon', 'background service'],
    steps: [
      'Determine the service type (simple, forking, oneshot, notify)',
      'Write the [Unit] section with description and dependencies',
      'Write the [Service] section with ExecStart, User, WorkingDirectory',
      'Configure restart policy and environment variables',
      'Write the [Install] section with WantedBy target',
      'Install the unit file to /etc/systemd/system/',
      'Enable and start the service, then check status'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Systemd Service\n\nCreate systemd service unit files for daemon processes.'
  },
  {
    slug: 'docker-compose',
    title: 'Docker Compose',
    summary: 'Create docker-compose configurations for multi-container applications.',
    triggerPhrases: ['create docker-compose', 'docker compose setup', 'multi-container', 'compose file', 'docker services'],
    steps: [
      'Identify all services the application needs (app, db, cache, etc.)',
      'Define each service with image, build context, and ports',
      'Configure volumes for persistent data and development mounts',
      'Set up networking between services',
      'Define environment variables and secrets',
      'Add health checks for critical services',
      'Test with docker compose up and verify connectivity'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Docker Compose\n\nCreate docker-compose configurations for multi-service applications.'
  },
  {
    slug: 'kubernetes-manifest',
    title: 'Kubernetes Manifest',
    summary: 'Create Kubernetes deployment, service, and ingress manifests.',
    triggerPhrases: ['create k8s manifest', 'kubernetes deployment', 'k8s config', 'deploy to kubernetes', 'k8s yaml'],
    steps: [
      'Define the Deployment with container spec, replicas, and resource limits',
      'Create a Service to expose the deployment (ClusterIP, NodePort, or LoadBalancer)',
      'Add ConfigMap and Secret resources for configuration',
      'Create Ingress resource for external access if needed',
      'Configure health checks (liveness and readiness probes)',
      'Add resource requests and limits for proper scheduling',
      'Validate manifests with kubectl --dry-run=client'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Kubernetes Manifest\n\nCreate Kubernetes deployment manifests with best practices.'
  },
  {
    slug: 'terraform-module',
    title: 'Terraform Module',
    summary: 'Create Terraform infrastructure-as-code modules.',
    triggerPhrases: ['create terraform', 'terraform module', 'infrastructure as code', 'terraform config', 'iac module'],
    steps: [
      'Define the infrastructure requirements and cloud provider',
      'Create main.tf with provider configuration and resources',
      'Create variables.tf with input variable definitions and defaults',
      'Create outputs.tf with useful output values',
      'Add terraform.tfvars.example with sample values',
      'Run terraform init and terraform plan to validate',
      'Document the module usage in a README'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Terraform Module\n\nCreate reusable Terraform infrastructure modules.'
  },

  // ── Testing ─────────────────────────────────────────────────────────

  {
    slug: 'test-e2e',
    title: 'End-to-End Tests',
    summary: 'Write end-to-end tests with Playwright for web applications.',
    triggerPhrases: ['write e2e tests', 'playwright test', 'end to end test', 'browser test', 'e2e testing'],
    steps: [
      'Identify the user flow to test (login, checkout, form submission, etc.)',
      'Set up the Playwright test file with proper imports',
      'Write page navigation and element selectors',
      'Add user interaction steps (click, fill, select)',
      'Assert expected outcomes (text content, URL, element visibility)',
      'Add error state and edge case tests',
      'Run tests and verify they pass in headed and headless modes'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# End-to-End Tests\n\nWrite Playwright-based end-to-end tests for web applications.'
  },
  {
    slug: 'test-api',
    title: 'API Integration Tests',
    summary: 'Write API integration tests for REST endpoints.',
    triggerPhrases: ['test api', 'api integration test', 'test endpoint', 'api test', 'test rest api'],
    steps: [
      'Identify the API endpoints to test',
      'Set up the test environment with test database/fixtures',
      'Write tests for successful requests (200, 201 responses)',
      'Write tests for validation errors (400 responses)',
      'Write tests for authentication/authorization (401, 403 responses)',
      'Write tests for not-found cases (404 responses)',
      'Test edge cases (empty body, large payloads, concurrent requests)',
      'Run tests and verify all pass'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# API Integration Tests\n\nWrite integration tests for REST API endpoints.'
  },
  {
    slug: 'test-component',
    title: 'React Component Tests',
    summary: 'Write React component tests with Testing Library.',
    triggerPhrases: ['test component', 'component test', 'react test', 'test react component', 'testing library'],
    steps: [
      'Identify the component and its props/states to test',
      'Set up the test file with render and screen imports',
      'Write tests for default render state',
      'Test user interactions (click, type, select) with userEvent',
      'Test conditional rendering and edge cases',
      'Test accessibility (role queries, aria attributes)',
      'Mock external dependencies (API calls, context, router)',
      'Run tests and check coverage'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# React Component Tests\n\nWrite component tests using React Testing Library.'
  },

  // ── Documentation ──────────────────────────────────────────────────

  {
    slug: 'api-docs',
    title: 'API Documentation',
    summary: 'Generate API documentation from code with endpoint specs.',
    triggerPhrases: ['document api', 'api docs', 'generate api documentation', 'openapi spec', 'swagger docs'],
    steps: [
      'Scan the codebase for API route handlers',
      'Extract endpoint paths, HTTP methods, and handler logic',
      'Document request parameters, body schema, and headers',
      'Document response schemas with status codes',
      'Add example requests and responses',
      'Format as OpenAPI/Swagger spec or markdown',
      'Validate documentation accuracy against actual implementation'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# API Documentation\n\nGenerate comprehensive API documentation from source code.'
  },
  {
    slug: 'architecture-doc',
    title: 'Architecture Decision Record',
    summary: 'Create architecture decision records (ADRs) for design decisions.',
    triggerPhrases: ['architecture decision', 'create ADR', 'document architecture', 'design decision', 'architecture doc'],
    steps: [
      'Define the architectural context and problem statement',
      'List the decision drivers and constraints',
      'Describe the considered alternatives with pros/cons',
      'State the chosen solution and rationale',
      'Document the consequences (positive, negative, neutral)',
      'Add implementation notes and references',
      'File the ADR with proper numbering in the docs directory'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Architecture Decision Record\n\nCreate structured ADRs for architectural decisions.'
  },
  {
    slug: 'changelog',
    title: 'Changelog Generation',
    summary: 'Generate changelog entries from git history.',
    triggerPhrases: ['generate changelog', 'update changelog', 'write changelog', 'release notes'],
    steps: [
      'Determine the version range (last tag to HEAD)',
      'Fetch git log with conventional commit messages',
      'Group commits by type (features, fixes, breaking changes, etc.)',
      'Write human-readable changelog entries for each group',
      'Highlight breaking changes prominently',
      'Add the date and version header',
      'Prepend to CHANGELOG.md file'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Changelog Generation\n\nGenerate changelog entries from git commit history.'
  },

  // ── Productivity ───────────────────────────────────────────────────

  {
    slug: 'cron-schedule',
    title: 'Cron Schedule',
    summary: 'Create and explain cron schedule expressions.',
    triggerPhrases: ['create cron', 'cron schedule', 'cron expression', 'schedule task', 'crontab'],
    steps: [
      'Understand the desired schedule (frequency, time, day)',
      'Construct the 5-field cron expression (minute, hour, day, month, weekday)',
      'Explain each field of the expression in plain English',
      'Provide example execution times for verification',
      'Add the cron entry with the command to run',
      'Document timezone considerations'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Cron Schedule\n\nCreate and explain cron schedule expressions with examples.'
  },
  {
    slug: 'regex-builder',
    title: 'Regex Builder',
    summary: 'Build and explain regular expressions with test cases.',
    triggerPhrases: ['build regex', 'create regex', 'regular expression', 'regex pattern', 'write regex'],
    steps: [
      'Understand the matching requirements and sample inputs',
      'Build the regex pattern incrementally',
      'Explain each part of the pattern in plain English',
      'Test against positive examples (should match)',
      'Test against negative examples (should not match)',
      'Test edge cases (empty string, special characters, Unicode)',
      'Provide the final pattern with usage notes and flags'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Regex Builder\n\nBuild, explain, and test regular expressions.'
  },
  {
    slug: 'shell-script',
    title: 'Shell Script',
    summary: 'Write robust shell scripts with error handling and portability.',
    triggerPhrases: ['write shell script', 'create bash script', 'shell script', 'automation script', 'write bash'],
    steps: [
      'Define the script purpose and expected inputs',
      'Add shebang line and set error handling (set -euo pipefail)',
      'Define variables and parse arguments',
      'Implement the main logic with functions',
      'Add error handling and cleanup traps',
      'Add usage/help message',
      'Test the script with various inputs and edge cases',
      'Make executable and add to appropriate location'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Shell Script\n\nWrite robust, portable shell scripts with proper error handling.'
  },

  // ── Research ───────────────────────────────────────────────────────

  {
    slug: 'literature-search',
    title: 'Literature Search',
    summary: 'Search and summarize academic papers and technical literature.',
    triggerPhrases: ['search papers', 'literature review', 'find research', 'academic search', 'paper summary'],
    steps: [
      'Define the research question and scope',
      'Search for relevant papers using keywords and filters',
      'Screen results for relevance based on title and abstract',
      'Read and extract key findings from selected papers',
      'Identify common themes, agreements, and contradictions',
      'Synthesize findings into a structured summary',
      'Provide citations in a standard format'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Literature Search\n\nSearch and summarize academic papers on a given topic.'
  },
  {
    slug: 'competitive-analysis',
    title: 'Competitive Analysis',
    summary: 'Analyze competitor products, features, and market positioning.',
    triggerPhrases: ['competitive analysis', 'analyze competitors', 'competitor comparison', 'market analysis', 'compare products'],
    steps: [
      'Identify the target market and direct competitors',
      'Research each competitor\'s product features and pricing',
      'Analyze strengths and weaknesses of each competitor',
      'Compare feature matrices across competitors',
      'Identify market gaps and opportunities',
      'Summarize findings with strategic recommendations'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Competitive Analysis\n\nAnalyze competitors and identify market opportunities.'
  },
  {
    slug: 'technology-comparison',
    title: 'Technology Comparison',
    summary: 'Compare frameworks, libraries, or tools with structured pros/cons.',
    triggerPhrases: ['compare frameworks', 'compare libraries', 'which framework', 'technology comparison', 'should I use'],
    steps: [
      'Identify the technologies to compare and evaluation criteria',
      'Research each technology\'s features, maturity, and community',
      'Evaluate performance characteristics and benchmarks',
      'Compare developer experience (DX), documentation, and learning curve',
      'Assess ecosystem (plugins, integrations, community support)',
      'Create a structured comparison table with ratings',
      'Provide a recommendation based on the specific use case'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Technology Comparison\n\nCompare technologies with structured evaluation criteria.'
  },

  // ── Media ──────────────────────────────────────────────────────────

  {
    slug: 'youtube-summary',
    title: 'YouTube Summary',
    summary: 'Summarize YouTube video content from transcripts.',
    triggerPhrases: ['summarize youtube', 'youtube summary', 'summarize video', 'video summary', 'watch this video'],
    steps: [
      'Extract the video ID from the YouTube URL',
      'Fetch the video transcript/captions',
      'Identify the main topics and key timestamps',
      'Write a concise summary of the main points',
      'Extract notable quotes or statistics mentioned',
      'Format the summary with timestamps for easy reference'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# YouTube Summary\n\nSummarize YouTube videos from their transcripts.'
  },
  {
    slug: 'podcast-notes',
    title: 'Podcast Notes',
    summary: 'Create structured notes from podcast or audio content.',
    triggerPhrases: ['podcast notes', 'summarize podcast', 'podcast summary', 'audio notes', 'meeting notes'],
    steps: [
      'Obtain the transcript or content source',
      'Identify speakers and segment boundaries',
      'Extract key topics, arguments, and conclusions',
      'Note important data points, names, and references mentioned',
      'Create a structured outline with timestamps',
      'Write a concise executive summary',
      'List action items or follow-up topics if applicable'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Podcast Notes\n\nCreate structured notes from podcast or audio content.'
  },

  // ── Security ───────────────────────────────────────────────────────

  {
    slug: 'dependency-audit',
    title: 'Dependency Audit',
    summary: 'Audit npm/pip/cargo dependencies for known vulnerabilities.',
    triggerPhrases: ['audit dependencies', 'check vulnerabilities', 'npm audit', 'dependency security', 'security scan'],
    steps: [
      'Identify the package manager (npm, pip, cargo, etc.)',
      'Run the built-in audit command (npm audit, pip-audit, cargo audit)',
      'Parse the vulnerability report for severity levels',
      'Identify which vulnerabilities have available fixes',
      'Apply automatic fixes where safe (npm audit fix)',
      'Manually evaluate high-severity issues without auto-fix',
      'Document remaining risks and mitigation strategies'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Dependency Audit\n\nAudit project dependencies for known security vulnerabilities.'
  },
  {
    slug: 'penetration-test-plan',
    title: 'Penetration Test Plan',
    summary: 'Create a structured penetration testing plan for web applications.',
    triggerPhrases: ['pen test plan', 'penetration testing', 'security testing plan', 'pentest', 'security assessment'],
    steps: [
      'Define the scope and target systems',
      'Enumerate the attack surface (endpoints, auth flows, inputs)',
      'Plan reconnaissance steps (technology fingerprinting, endpoint discovery)',
      'Define injection test cases (SQL, XSS, SSRF, command injection)',
      'Plan authentication/authorization bypass tests',
      'Define business logic abuse scenarios',
      'Create the test execution checklist with severity ratings',
      'Document reporting format and remediation guidance'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Penetration Test Plan\n\nCreate a structured penetration testing plan for web applications.'
  },

  // ── Bonus: Additional Practical Skills ─────────────────────────────

  {
    slug: 'monorepo-setup',
    title: 'Monorepo Setup',
    summary: 'Set up a monorepo with workspaces, shared configs, and cross-package dependencies.',
    triggerPhrases: ['setup monorepo', 'create monorepo', 'monorepo structure', 'workspace setup', 'turborepo setup'],
    steps: [
      'Choose the monorepo tool (npm workspaces, pnpm workspaces, Turborepo, Nx)',
      'Create the root package.json with workspace configuration',
      'Set up the package directory structure (packages/, apps/)',
      'Configure shared TypeScript, ESLint, and Prettier configs',
      'Set up build pipeline with dependency ordering',
      'Configure cross-package imports and references',
      'Verify builds and tests run correctly across all packages'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Monorepo Setup\n\nSet up a monorepo with workspaces and shared configuration.'
  },
  {
    slug: 'database-schema-design',
    title: 'Database Schema Design',
    summary: 'Design relational database schemas with proper normalization and indexes.',
    triggerPhrases: ['design database', 'schema design', 'database model', 'design tables', 'data model'],
    steps: [
      'Gather requirements and identify entities',
      'Define tables with columns, types, and constraints',
      'Establish relationships (one-to-one, one-to-many, many-to-many)',
      'Normalize to 3NF and denormalize intentionally where needed',
      'Add indexes for common query patterns',
      'Define foreign keys and cascade behaviors',
      'Create the migration files or SQL DDL',
      'Review for data integrity and performance'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Database Schema Design\n\nDesign relational database schemas with proper normalization.'
  },
  {
    slug: 'ci-pipeline',
    title: 'CI Pipeline Setup',
    summary: 'Create CI/CD pipeline configuration for automated testing and deployment.',
    triggerPhrases: ['setup CI', 'create pipeline', 'CI/CD setup', 'continuous integration', 'github workflow'],
    steps: [
      'Choose the CI platform (GitHub Actions, GitLab CI, CircleCI)',
      'Define trigger events (push, PR, schedule)',
      'Configure the build environment (runtime versions, caching)',
      'Add lint and type-check steps',
      'Add test execution steps with coverage reporting',
      'Add build/deploy steps for applicable environments',
      'Configure notifications for failures',
      'Test the pipeline with a dummy commit'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# CI Pipeline Setup\n\nCreate CI/CD pipeline configuration for automated workflows.'
  },
  {
    slug: 'auth-implementation',
    title: 'Authentication Implementation',
    summary: 'Implement authentication with session management and security best practices.',
    triggerPhrases: ['implement auth', 'add authentication', 'login system', 'auth setup', 'user authentication'],
    steps: [
      'Choose the auth strategy (session-based, JWT, OAuth2, passkeys)',
      'Set up the auth provider or library',
      'Implement signup/login/logout endpoints or flows',
      'Add password hashing (bcrypt/argon2) for credential-based auth',
      'Implement session or token management with secure storage',
      'Add route protection middleware',
      'Handle auth errors and edge cases (expired sessions, concurrent logins)',
      'Write tests for auth flows'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Authentication Implementation\n\nImplement authentication with security best practices.'
  },
  {
    slug: 'email-template',
    title: 'Email Template',
    summary: 'Create responsive HTML email templates compatible with major email clients.',
    triggerPhrases: ['create email template', 'html email', 'email design', 'transactional email', 'email layout'],
    steps: [
      'Define the email type (transactional, marketing, notification)',
      'Create table-based HTML layout for email client compatibility',
      'Add inline CSS styles (no external stylesheets)',
      'Include responsive meta tags and media queries where supported',
      'Add placeholder variables for dynamic content',
      'Test rendering in major email clients (Gmail, Outlook, Apple Mail)',
      'Validate HTML for common email pitfalls'
    ],
    sourceMessages: 0,
    status: 'published',
    markdown: '# Email Template\n\nCreate responsive HTML email templates for major email clients.'
  }
];

export function getBuiltInSkills(): StoredSkillDraft[] {
  const now = new Date().toISOString();
  return BUILT_IN_SKILLS.map((skill) => ({
    ...skill,
    id: `builtin-${skill.slug}`,
    createdAt: now,
    updatedAt: now
  }));
}

export async function loadBuiltInSkills(store: SkillStore): Promise<number> {
  const skills = getBuiltInSkills();
  let loaded = 0;
  for (const skill of skills) {
    const existing = await store.get(skill.id);
    if (!existing) {
      await store.save(skill);
      loaded++;
    }
  }
  return loaded;
}
