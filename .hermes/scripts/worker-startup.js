#!/usr/bin/env node
/**
 * Worker Startup Script
 * Shows each worker their assigned tasks and provides guidance
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..');

function getWorkerId() {
  // In a real system, this would be determined by environment or worker identity
  const workerId = process.env.WORKER_ID || process.argv[2];
  
  if (!workerId) {
    console.error('❌ Worker ID not provided');
    console.log('Usage: node startup.js <worker-id>');
    console.log('Available workers:');
    console.log('  - worker-ts-browser');
    console.log('  - worker-rust-agent'); 
    console.log('  - worker-go-config');
    process.exit(1);
  }
  
  return workerId;
}

function loadWorkerProfile(workerId) {
  const profilePath = join(__dirname, '..', 'workers', `${workerId}.json`);
  
  if (!existsSync(profilePath)) {
    console.error(`❌ Worker profile not found: ${profilePath}`);
    process.exit(1);
  }
  
  return JSON.parse(readFileSync(profilePath, 'utf8'));
}

function loadAssignments() {
  const assignmentsPath = join(__dirname, '..', 'kanban', 'assignments.md');
  
  if (!existsSync(assignmentsPath)) {
    console.error('❌ Task assignments not found. Run: node assign-tasks.js');
    process.exit(1);
  }
  
  return readFileSync(assignmentsPath, 'utf8');
}

function parseWorkerTasks(assignmentsContent, workerId) {
  const lines = assignmentsContent.split('\n');
  let inWorkerSection = false;
  const tasks = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Check if we're entering this worker's section
    if (line.includes(`## ${workerId}`)) {
      inWorkerSection = true;
      continue;
    }
    
    // Also check for worker name in parentheses
    if (line.includes(`(${workerId})`)) {
      inWorkerSection = true;
      continue;
    }
    
    // Check if we're leaving this worker's section
    if (inWorkerSection && line.startsWith('## ') && !line.includes(workerId)) {
      break;
    }
    
    // Parse task rows
    if (inWorkerSection && line.startsWith('| ') && line.includes('| Task |')) {
      // This is the header row, skip
      continue;
    }
    
    if (inWorkerSection && line.startsWith('| ') && !line.includes('--')) {
      const parts = line.split('|').map(p => p.trim());
      if (parts.length >= 4) {
        tasks.push({
          id: parts[1],
          title: parts[2],
          priority: parts[3],
          file: parts[4]
        });
      }
    }
  }
  
  return tasks;
}

function generateTaskInstructions(worker, tasks) {
  const profile = worker.profile;
  
  let instructions = `\n# 📋 Your Assigned Tasks\n`;
  instructions += `**Worker:** ${profile.name} (${profile.worker_id})\n`;
  instructions += `**Start Time:** ${profile.working_hours.start} UTC\n`;
  instructions += `**Capacity:** ${profile.capacity.parallel_tasks} tasks in parallel\n\n`;
  
  if (tasks.length === 0) {
    instructions += `🎉 No tasks assigned! Check back later or take a break.\n\n`;
    return instructions;
  }
  
  instructions += `📝 **Priority Order:**\n`;
  const priorityOrder = { 'High': 1, 'Medium': 2, 'Low': 3 };
  tasks.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
  
  tasks.forEach((task, index) => {
    instructions += `${index + 1}. **Task ${task.id}** (${task.priority} priority)\n`;
    instructions += `   - ${task.title}\n`;
    instructions += `   - File: ${task.file}\n\n`;
  });
  
  instructions += `💡 **Getting Started:**\n`;
  instructions += `1. Start with the highest priority task\n`;
  instructions += `2. Update task status to "In Progress" when you begin\n`;
  instructions += `3. Update to "Done" when completed\n`;
  instructions += `4. Run 'node assign-tasks.js' to get new tasks when done\n\n`;
  
  instructions += `🔧 **Your Tools:**\n`;
  instructions += `- IDE: ${profile.tools.ide}\n`;
  instructions += `- Testing: ${profile.tools.testing_framework}\n`;
  instructions += `- Build: ${profile.tools.build_system}\n\n`;
  
  return instructions;
}

function main() {
  const workerId = getWorkerId();
  
  console.log(`🚀 Starting worker: ${workerId}`);
  console.log('='.repeat(50));
  
  // Load worker profile
  const worker = loadWorkerProfile(workerId);
  console.log(`✅ Worker profile loaded: ${worker.profile.name}`);
  
  // Load assignments
  const assignments = loadAssignments();
  const tasks = parseWorkerTasks(assignments, workerId);
  
  // Generate and display instructions
  const instructions = generateTaskInstructions(worker, tasks);
  console.log(instructions);
  
  // Save instructions for worker
  const instructionsPath = join(__dirname, '..', 'kanban', `${workerId}-instructions.md`);
  writeFileSync(instructionsPath, instructions);
  console.log(`📄 Instructions saved to: ${instructionsPath}`);
  
  console.log('🎯 Ready to start! Good luck!');
}

// Main execution
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}