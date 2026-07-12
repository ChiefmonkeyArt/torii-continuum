#!/usr/bin/env node
/**
 * Worker Task Assignment Script
 * Configures workers to pick up tasks from the kanban board
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

// Get current directory for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..');

// Load kanban board
const kanbanPath = join(process.cwd(), '.hermes/kanban/browser-keygen-hybrid-onboarding.md');
const kanbanContent = readFileSync(kanbanPath, 'utf8');

// Load worker profiles
const workers = [
  JSON.parse(readFileSync(join(process.cwd(), '.hermes/workers/worker-ts-browser.json'), 'utf8')),
  JSON.parse(readFileSync(join(process.cwd(), '.hermes/workers/worker-rust-agent.json'), 'utf8')),
  JSON.parse(readFileSync(join(process.cwd(), '.hermes/workers/worker-go-config.json'), 'utf8'))
];

class TaskScheduler {
  constructor() {
    this.tasks = this.parseKanbanBoard(kanbanContent);
    this.workers = workers;
    this.assignments = new Map();
  }

  parseKanbanBoard(content) {
    const tasks = [];
    const lines = content.split('\n');
    let currentProject = '';
    let currentPhase = '';
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Project headers
      if (line.startsWith('## Project:')) {
        currentProject = line.replace('## Project:', '').trim();
        continue;
      }
      
      // Phase headers  
      if (line.startsWith('### Phase') && line.includes('(Ready)')) {
        currentPhase = line.replace('###', '').replace('(Ready)', '').trim();
        continue;
      }
      
      // Task items
      if (line.startsWith('- [ ] Task')) {
        const taskMatch = line.match(/- \[ \] Task (\d+): (.+)/);
        if (taskMatch) {
          const taskId = parseInt(taskMatch[1]);
          const taskTitle = taskMatch[2];
          
          // Extract task details from following lines
          let description = '';
          let file = '';
          let worker = '';
          let priority = 'Medium';
          let storyPoints = 1;
          
          for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
            const detailLine = lines[j];
            if (detailLine.includes('Description:')) {
              description = detailLine.split('Description:')[1]?.trim() || '';
            } else if (detailLine.includes('File:')) {
              file = detailLine.split('File:')[1]?.trim() || '';
            } else if (detailLine.includes('Worker:')) {
              worker = detailLine.split('Worker:')[1]?.trim() || '';
            } else if (detailLine.includes('Priority:')) {
              priority = detailLine.split('Priority:')[1]?.trim() || 'Medium';
            } else if (detailLine.includes('Story points:')) {
              storyPoints = parseInt(detailLine.split('Story points:')[1]?.trim() || '1');
            } else if (detailLine.startsWith('###') || line.startsWith('##')) {
              break;
            }
          }
          
          tasks.push({
            id: taskId,
            title: taskTitle,
            project: currentProject,
            phase: currentPhase,
            description,
            file,
            worker,
            priority,
            storyPoints,
            status: 'Ready',
            assignedTo: null
          });
        }
      }
    }
    
    return tasks;
  }

  assignTasks() {
    // Group tasks by worker
    const workerTasks = new Map();
    this.tasks.forEach(task => {
      if (!workerTasks.has(task.worker)) {
        workerTasks.set(task.worker, []);
      }
      workerTasks.get(task.worker).push(task);
    });

    // Assign tasks based on worker capacity
    workerTasks.forEach((tasks, workerId) => {
      const worker = this.workers.find(w => w.profile.worker_id === workerId);
      if (!worker) {
        console.warn(`Worker ${workerId} not found in profiles`);
        return;
      }

      // Sort by priority and age
      tasks.sort((a, b) => {
        const priorityOrder = { 'High': 3, 'Medium': 2, 'Low': 1 };
        const priorityDiff = priorityOrder[b.priority] - priorityOrder[a.priority];
        if (priorityDiff !== 0) return priorityDiff;
        return a.id - b.id;
      });

      // Assign tasks up to worker capacity
      const capacity = worker.profile.capacity.parallel_tasks;
      const assigned = tasks.slice(0, capacity);
      
      assigned.forEach(task => {
        task.assignedTo = workerId;
        task.status = 'Assigned';
        this.assignments.set(workerId, (this.assignments.get(workerId) || []).concat([task]));
      });
    });

    return this.assignments;
  }

  generateAssignmentReport() {
    let report = '# Worker Task Assignments\n\n';
    report += `Generated: ${new Date().toISOString()}\n\n`;
    
    const assignments = this.assignTasks();
    
    assignments.forEach((tasks, workerId) => {
      const worker = this.workers.find(w => w.profile.worker_id === workerId);
      report += `## ${worker.profile.name} (${workerId})\n\n`;
      report += `**Capacity:** ${worker.profile.capacity.parallel_tasks} tasks in parallel\n`;
      report += `**Assigned Tasks:** ${tasks.length}\n\n`;
      
      if (tasks.length > 0) {
        report += '| ID | Task | Priority | File |\n';
        report += '|----|------|----------|------|\n';
        tasks.forEach(task => {
          report += `| ${task.id} | ${task.title} | ${task.priority} | ${task.file} |\n`;
        });
        report += '\n';
      } else {
        report += 'No tasks assigned\n\n';
      }
    });

    // Add unassigned tasks
    const unassigned = this.tasks.filter(t => !t.assignedTo);
    if (unassigned.length > 0) {
      report += '## Unassigned Tasks\n\n';
      report += '| ID | Task | Worker | Priority |\n';
      report += '|----|------|--------|----------|\n';
      unassigned.forEach(task => {
        report += `| ${task.id} | ${task.title} | ${task.worker} | ${task.priority} |\n`;
      });
    }

    return report;
  }

  saveAssignments() {
    const report = this.generateAssignmentReport();
    writeFileSync(
      join(process.cwd(), '.hermes/kanban/assignments.md'),
      report
    );
    console.log('Task assignments saved to .hermes/kanban/assignments.md');
  }
}

// Main execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const scheduler = new TaskScheduler();
  scheduler.saveAssignments();
  
  console.log('\n📋 Task Assignment Summary:');
  console.log(`Total tasks: ${scheduler.tasks.length}`);
  console.log(`Workers configured: ${workers.length}`);
  console.log('\nWorkers should check .hermes/kanban/assignments.md for their assigned tasks.');
}

export { TaskScheduler };