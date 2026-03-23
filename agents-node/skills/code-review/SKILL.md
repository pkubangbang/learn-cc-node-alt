---
name: code-review
description: Review code for quality, security, and best practices
tags: review, quality, security
---

# Code Review Skill

When reviewing code, follow this systematic approach:

## 1. Security Check
- Look for SQL injection, XSS, CSRF vulnerabilities
- Check for hardcoded secrets, API keys, passwords
- Verify input validation and sanitization
- Review authentication and authorization logic

## 2. Code Quality
- Check for clear naming conventions
- Look for code duplication (DRY principle)
- Verify function/method length (keep under 50 lines)
- Check for proper error handling

## 3. Performance
- Identify potential N+1 queries
- Check for unnecessary loops or recursion
- Look for memory leaks (unclosed connections, listeners)
- Verify efficient data structures

## 4. Testing
- Are there unit tests for critical paths?
- Check edge case coverage
- Verify mocking is appropriate

## 5. Documentation
- Are complex functions documented?
- Is the README up to date?
- Are there inline comments for non-obvious logic?